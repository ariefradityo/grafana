import type { Tree, SyntaxNode } from '@lezer/common';

import {
  parser,
  VectorAggregationExpr,
  String,
  Selector,
  RangeAggregationExpr,
  Range,
  PipelineExpr,
  PipelineStage,
  Matchers,
  Matcher,
  LogQL,
  LogRangeExpr,
  LogExpr,
  Logfmt,
  Identifier,
  Grouping,
  Expr,
  LiteralExpr,
  MetricExpr,
  UnwrapExpr,
  DropLabelsExpr,
  KeepLabelsExpr,
  DropLabels,
  KeepLabels,
  ParserFlag,
  LabelExtractionExpression,
  LabelExtractionExpressionList,
} from '@grafana/lezer-logql';

import { getLogQueryFromMetricsQuery, getNodesFromQuery } from '../../../queryUtils';

type Direction = 'parent' | 'firstChild' | 'lastChild' | 'nextSibling';
type NodeType = number;

type Path = Array<[Direction, NodeType]>;

function move(node: SyntaxNode, direction: Direction): SyntaxNode | null {
  return node[direction];
}

function walk(node: SyntaxNode, path: Path): SyntaxNode | null {
  let current: SyntaxNode | null = node;
  for (const [direction, expectedNode] of path) {
    current = move(current, direction);
    if (current === null) {
      // we could not move in the direction, we stop
      return null;
    }
    if (current.type.id !== expectedNode) {
      // the reached node has wrong type, we stop
      return null;
    }
  }
  return current;
}

function getNodeText(node: SyntaxNode, text: string): string {
  return text.slice(node.from, node.to);
}

function parseStringLiteral(text: string): string {
  // If it is a string-literal, it is inside quotes of some kind
  const inside = text.slice(1, text.length - 1);

  // Very simple un-escaping:

  // Double quotes
  if (text.startsWith('"') && text.endsWith('"')) {
    // NOTE: this is not 100% perfect, we only unescape the double-quote,
    // there might be other characters too
    return inside.replace(/\\"/gm, '"');
  }

  // Single quotes
  if (text.startsWith("'") && text.endsWith("'")) {
    // NOTE: this is not 100% perfect, we only unescape the single-quote,
    // there might be other characters too
    return inside.replace(/\\'/gm, "'");
  }

  // Backticks
  if (text.startsWith('`') && text.endsWith('`')) {
    return inside;
  }

  throw new Error(`Invalid string literal: ${text}`);
}

export type LabelOperator = '=' | '!=' | '=~' | '!~';

export type Label = {
  name: string;
  value: string;
  op: LabelOperator;
};

export type Situation =
  | {
      type: 'EMPTY';
    }
  | {
      type: 'AT_ROOT';
    }
  | {
      type: 'IN_LOGFMT';
      otherLabels: string[];
      flags: boolean;
      logQuery: string;
    }
  | {
      type: 'IN_RANGE';
    }
  | {
      type: 'IN_AGGREGATION';
    }
  | {
      type: 'IN_GROUPING';
      logQuery: string;
    }
  | {
      type: 'IN_LABEL_SELECTOR_NO_LABEL_NAME';
      otherLabels: Label[];
    }
  | {
      type: 'IN_LABEL_SELECTOR_WITH_LABEL_NAME';
      labelName: string;
      betweenQuotes: boolean;
      otherLabels: Label[];
    }
  | {
      type: 'AFTER_SELECTOR';
      afterPipe: boolean;
      hasSpace: boolean;
      logQuery: string;
    }
  | {
      type: 'AFTER_UNWRAP';
      logQuery: string;
    }
  | {
      type: 'AFTER_KEEP_AND_DROP';
      logQuery: string;
    };

type Resolver = {
  paths: NodeType[][];
  fun: (node: SyntaxNode, text: string, pos: number) => Situation | null;
};

function isPathMatch(resolverPath: NodeType[], cursorPath: number[]): boolean {
  return resolverPath.every((item, index) => item === cursorPath[index]);
}

const ERROR_NODE_ID = 0;

const RESOLVERS: Resolver[] = [
  {
    paths: [[Selector]],
    fun: resolveSelector,
  },
  {
    paths: [[ERROR_NODE_ID, Matchers, Selector]],
    fun: resolveSelector,
  },
  {
    paths: [
      [LogQL],
      [RangeAggregationExpr],
      [ERROR_NODE_ID, LogRangeExpr, RangeAggregationExpr],
      [ERROR_NODE_ID, LabelExtractionExpressionList],
      [LogRangeExpr],
      [ERROR_NODE_ID, LabelExtractionExpressionList],
      [LabelExtractionExpressionList],
    ],
    fun: resolveLogfmtParser,
  },
  {
    paths: [[LogQL]],
    fun: resolveTopLevel,
  },
  {
    paths: [[String, Matcher]],
    fun: resolveMatcher,
  },
  {
    paths: [[Grouping]],
    fun: resolveLabelsForGrouping,
  },
  {
    paths: [[LogRangeExpr]],
    fun: resolveLogRange,
  },
  {
    paths: [[ERROR_NODE_ID, Matcher]],
    fun: resolveMatcher,
  },
  {
    paths: [[ERROR_NODE_ID, Range]],
    fun: resolveDurations,
  },
  {
    paths: [[ERROR_NODE_ID, LogRangeExpr]],
    fun: resolveLogRangeFromError,
  },
  {
    paths: [[ERROR_NODE_ID, LiteralExpr, MetricExpr, VectorAggregationExpr]],
    fun: () => ({ type: 'IN_AGGREGATION' }),
  },
  {
    paths: [[ERROR_NODE_ID, PipelineStage, PipelineExpr]],
    fun: resolvePipeError,
  },
  {
    paths: [[ERROR_NODE_ID, UnwrapExpr], [UnwrapExpr]],
    fun: resolveAfterUnwrap,
  },
  {
    paths: [
      [ERROR_NODE_ID, DropLabelsExpr],
      [ERROR_NODE_ID, DropLabels],
      [ERROR_NODE_ID, KeepLabelsExpr],
      [ERROR_NODE_ID, KeepLabels],
    ],
    fun: resolveAfterKeepAndDrop,
  },
];

const LABEL_OP_MAP = new Map<string, LabelOperator>([
  ['Eq', '='],
  ['Re', '=~'],
  ['Neq', '!='],
  ['Nre', '!~'],
]);

function getLabelOp(opNode: SyntaxNode): LabelOperator | null {
  return LABEL_OP_MAP.get(opNode.name) ?? null;
}

function getLabel(matcherNode: SyntaxNode, text: string): Label | null {
  if (matcherNode.type.id !== Matcher) {
    return null;
  }

  const nameNode = walk(matcherNode, [['firstChild', Identifier]]);

  if (nameNode === null) {
    return null;
  }

  const opNode = nameNode.nextSibling;
  if (opNode === null) {
    return null;
  }

  const op = getLabelOp(opNode);
  if (op === null) {
    return null;
  }

  const valueNode = walk(matcherNode, [['lastChild', String]]);

  if (valueNode === null) {
    return null;
  }

  const name = getNodeText(nameNode, text);
  const value = parseStringLiteral(getNodeText(valueNode, text));

  return { name, value, op };
}

function getLabels(selectorNode: SyntaxNode, text: string): Label[] {
  if (selectorNode.type.id !== Selector) {
    return [];
  }

  let listNode: SyntaxNode | null = walk(selectorNode, [['firstChild', Matchers]]);

  const labels: Label[] = [];

  while (listNode !== null) {
    const matcherNode = walk(listNode, [['lastChild', Matcher]]);
    if (matcherNode !== null) {
      const label = getLabel(matcherNode, text);
      if (label !== null) {
        labels.push(label);
      }
    }

    // there might be more labels
    listNode = walk(listNode, [['firstChild', Matchers]]);
  }

  // our labels-list is last-first, so we reverse it
  labels.reverse();

  return labels;
}

function resolveAfterUnwrap(node: SyntaxNode, text: string, pos: number): Situation | null {
  return {
    type: 'AFTER_UNWRAP',
    logQuery: getLogQueryFromMetricsQuery(text).trim(),
  };
}

function resolvePipeError(node: SyntaxNode, text: string, pos: number): Situation | null {
  // for example `{level="info"} |`
  const exprNode = walk(node, [
    ['parent', PipelineStage],
    ['parent', PipelineExpr],
  ]);

  if (exprNode === null) {
    return null;
  }

  const { parent } = exprNode;

  if (parent === null) {
    return null;
  }

  if (parent.type.id === LogExpr || parent.type.id === LogRangeExpr) {
    return resolveLogOrLogRange(parent, text, pos, true);
  }

  return null;
}

function resolveLabelsForGrouping(node: SyntaxNode, text: string, pos: number): Situation | null {
  const aggrExpNode = walk(node, [['parent', VectorAggregationExpr]]);
  if (aggrExpNode === null) {
    return null;
  }
  const bodyNode = aggrExpNode.getChild('MetricExpr');
  if (bodyNode === null) {
    return null;
  }

  const selectorNode = walk(bodyNode, [
    ['firstChild', RangeAggregationExpr],
    ['lastChild', LogRangeExpr],
    ['firstChild', Selector],
  ]);

  if (selectorNode === null) {
    return null;
  }

  return {
    type: 'IN_GROUPING',
    logQuery: getLogQueryFromMetricsQuery(text).trim(),
  };
}

function resolveMatcher(node: SyntaxNode, text: string, pos: number): Situation | null {
  // we can arrive here for two reasons. `node` is either:
  // - a StringNode (like in `{job="^"}`)
  // - or an error node (like in `{job=^}`)
  const inStringNode = !node.type.isError;

  const parent = walk(node, [['parent', Matcher]]);
  if (parent === null) {
    return null;
  }

  const labelNameNode = walk(parent, [['firstChild', Identifier]]);
  if (labelNameNode === null) {
    return null;
  }

  const labelName = getNodeText(labelNameNode, text);

  // now we need to go up, to the parent of Matcher,
  // there can be one or many `Matchers` parents, we have
  // to go through all of them

  const firstListNode = walk(parent, [['parent', Matchers]]);
  if (firstListNode === null) {
    return null;
  }

  let listNode = firstListNode;

  // we keep going through the parent-nodes as long as they are Matchers.
  // as soon as we reach Selector, we stop
  let selectorNode: SyntaxNode | null = null;
  while (selectorNode === null) {
    const parent = listNode.parent;
    if (parent === null) {
      return null;
    }

    switch (parent.type.id) {
      case Matchers:
        //we keep looping
        listNode = parent;
        continue;
      case Selector:
        // we reached the end, we can stop the loop
        selectorNode = parent;
        continue;
      default:
        // we reached some other node, we stop
        return null;
    }
  }

  // now we need to find the other names
  const allLabels = getLabels(selectorNode, text);

  // we need to remove "our" label from all-labels, if it is in there
  const otherLabels = allLabels.filter((label) => label.name !== labelName);

  return {
    type: 'IN_LABEL_SELECTOR_WITH_LABEL_NAME',
    labelName,
    betweenQuotes: inStringNode,
    otherLabels,
  };
}

function resolveLogfmtParser(_: SyntaxNode, text: string, cursorPosition: number): Situation | null {
  // We want to know if the cursor if after a log query with logfmt parser.
  // E.g. `{x="y"} | logfmt ^`

  const tree = parser.parse(text);

  // Adjust the cursor position if there are spaces at the end of the text.
  const trimRightTextLen = text.substring(0, cursorPosition).trimEnd().length;
  const position = trimRightTextLen < cursorPosition ? trimRightTextLen : cursorPosition;

  const cursor = tree.cursorAt(position);

  // Check if the user cursor is in any node that requires logfmt suggestions.
  const expectedNodes = [Logfmt, ParserFlag, LabelExtractionExpression, LabelExtractionExpressionList];
  let inLogfmt = false;
  do {
    const { node } = cursor;
    if (!expectedNodes.includes(node.type.id)) {
      continue;
    }
    if (cursor.from <= position && cursor.to >= position) {
      inLogfmt = true;
      break;
    }
  } while (cursor.next());

  if (!inLogfmt) {
    return null;
  }

  const flags = getNodesFromQuery(text, [ParserFlag]).length > 1;
  const labelNodes = getNodesFromQuery(text, [LabelExtractionExpression]);
  const otherLabels = labelNodes
    .map((label: SyntaxNode) => label.getChild(Identifier))
    .filter((label: SyntaxNode | null): label is SyntaxNode => label !== null)
    .map((label: SyntaxNode) => getNodeText(label, text));

  return {
    type: 'IN_LOGFMT',
    otherLabels,
    flags,
    logQuery: getLogQueryFromMetricsQuery(text).trim(),
  };
}

function resolveTopLevel(node: SyntaxNode, text: string, pos: number): Situation | null {
  // we try a couply specific paths here.
  // `{x="y"}` situation, with the cursor at the end

  const logExprNode = walk(node, [
    ['lastChild', Expr],
    ['lastChild', LogExpr],
  ]);

  if (logExprNode != null) {
    return resolveLogOrLogRange(logExprNode, text, pos, false);
  }

  // `s` situation, with the cursor at the end.
  // (basically, user enters a non-special characters as first
  // character in query field)
  const idNode = walk(node, [
    ['firstChild', ERROR_NODE_ID],
    ['firstChild', Identifier],
  ]);

  if (idNode != null) {
    return {
      type: 'AT_ROOT',
    };
  }

  // no patterns match
  return null;
}

function resolveDurations(node: SyntaxNode, text: string, pos: number): Situation {
  return {
    type: 'IN_RANGE',
  };
}

function resolveLogRange(node: SyntaxNode, text: string, pos: number): Situation | null {
  const partialQuery = text.substring(0, pos).trimEnd();
  const afterPipe = partialQuery.endsWith('|');

  return resolveLogOrLogRange(node, text, pos, afterPipe);
}

function resolveLogRangeFromError(node: SyntaxNode, text: string, pos: number): Situation | null {
  const parent = walk(node, [['parent', LogRangeExpr]]);
  if (parent === null) {
    return null;
  }

  const partialQuery = text.substring(0, pos).trimEnd();
  const afterPipe = partialQuery.endsWith('|');

  return resolveLogOrLogRange(parent, text, pos, afterPipe);
}

function resolveLogOrLogRange(node: SyntaxNode, text: string, pos: number, afterPipe: boolean): Situation | null {
  // Here the `node` is either a LogExpr or a LogRangeExpr
  // We want to handle the case where we are next to a selector
  const selectorNode = walk(node, [['firstChild', Selector]]);

  // Check that the selector is before the cursor, not after it
  if (!selectorNode || selectorNode.to > pos) {
    return null;
  }

  return {
    type: 'AFTER_SELECTOR',
    afterPipe,
    hasSpace: text.charAt(pos - 1) === ' ',
    logQuery: getLogQueryFromMetricsQuery(text).trim(),
  };
}

function resolveSelector(node: SyntaxNode, text: string, pos: number): Situation | null {
  // for example `{^}`

  // false positive:
  // `{a="1"^}`
  const child = walk(node, [['firstChild', Matchers]]);
  if (child !== null) {
    // means the label-matching part contains at least one label already.
    //
    // in this case, we will need to have a `,` character at the end,
    // to be able to suggest adding the next label.
    // the area between the end-of-the-child-node and the cursor-pos
    // must contain a `,` in this case.
    const textToCheck = text.slice(child.from, pos);
    if (!textToCheck.trim().endsWith(',')) {
      return null;
    }
  }

  const selectorNode =
    node.type.id === ERROR_NODE_ID
      ? walk(node, [
          ['parent', Matchers],
          ['parent', Selector],
        ])
      : node;
  if (!selectorNode) {
    return null;
  }

  const otherLabels = getLabels(selectorNode, text);

  return {
    type: 'IN_LABEL_SELECTOR_NO_LABEL_NAME',
    otherLabels,
  };
}

function resolveAfterKeepAndDrop(node: SyntaxNode, text: string, pos: number): Situation | null {
  let logQuery = getLogQueryFromMetricsQuery(text).trim();
  let keepAndDropParent: SyntaxNode | null = null;
  let parent = node.parent;
  while (parent !== null) {
    if (parent.type.id === PipelineStage) {
      keepAndDropParent = parent;
      break;
    }
    parent = parent.parent;
  }

  if (keepAndDropParent?.type.id === PipelineStage) {
    logQuery = logQuery.slice(0, keepAndDropParent.from);
  }

  return {
    type: 'AFTER_KEEP_AND_DROP',
    logQuery,
  };
}

// we find the first error-node in the tree that is at the cursor-position.
// NOTE: this might be too slow, might need to optimize it
// (ideas: we do not need to go into every subtree, based on from/to)
// also, only go to places that are in the sub-tree of the node found
// by default by lezer. problem is, `next()` will go upward too,
// and we do not want to go higher than our node
function getErrorNode(tree: Tree, text: string, cursorPos: number): SyntaxNode | null {
  // sometimes the cursor is a couple spaces after the end of the expression.
  // to account for this situation, we "move" the cursor position back,
  // so that there are no spaces between the end-of-expression and the cursor
  const trimRightTextLen = text.trimEnd().length;
  const pos = trimRightTextLen < cursorPos ? trimRightTextLen : cursorPos;
  const cur = tree.cursorAt(pos);
  do {
    if (cur.from === pos && cur.to === pos) {
      const { node } = cur;
      if (node.type.isError) {
        return node;
      }
    }
  } while (cur.next());
  return null;
}

export function getSituation(text: string, pos: number): Situation | null {
  // there is a special case when we are at the start of writing text,
  // so we handle that case first

  if (text === '') {
    return {
      type: 'EMPTY',
    };
  }

  const tree = parser.parse(text);

  // if the tree contains error, it is very probable that
  // our node is one of those error nodes.
  // also, if there are errors, the node lezer finds us,
  // might not be the best node.
  // so first we check if there is an error node at the cursor position
  const maybeErrorNode = getErrorNode(tree, text, pos);

  const cur = maybeErrorNode != null ? maybeErrorNode.cursor() : tree.cursorAt(pos);

  const currentNode = cur.node;

  const ids = [cur.type.id];
  while (cur.parent()) {
    ids.push(cur.type.id);
  }

  for (let resolver of RESOLVERS) {
    for (let path of resolver.paths) {
      if (isPathMatch(path, ids)) {
        const situation = resolver.fun(currentNode, text, pos);
        if (situation) {
          return situation;
        }
      }
    }
  }

  return null;
}

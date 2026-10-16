/**
 * "No string left behind" (T-050): finds words typed straight into player-facing JSX instead of
 * coming from the catalogs (lib/i18n/messages). A pragmatic check, not a parser of meaning:
 *
 * - JSX text with letters (`<p>Hello</p>`);
 * - string literals with letters in props that people read or hear (`aria-label`, `title`,
 *   `placeholder`, `alt`, …, see `TEXT_PROPS`), directly or as a branch of `?:`, `??`, `||`;
 * - the same literals as JSX children (`{busy ? 'Saving…' : 'Save'}`).
 *
 * Not checked: other props (`className`, `data-*`, `href`, …), strings built in plain
 * functions (those go through a catalog function anyway when they reach the page), and what
 * `ALLOWED` lists (the brand, examples that are the same in every language).
 *
 * Run by `hardcoded-strings.test.ts` over `src/components` and `src/app` (not `/admin`, which
 * stays English). README "Languages" says how to add a string.
 */
import ts from 'typescript';

/** Props whose value is read or heard by people. */
export const TEXT_PROPS = new Set([
  'aria-label',
  'aria-description',
  'aria-placeholder',
  'aria-roledescription',
  'aria-valuetext',
  'title',
  'placeholder',
  'alt',
  'label',
  'confirm',
  'body',
  'text',
  'heading',
  'message',
  'caption',
  'subtitle',
  'shippedNote',
  'hostName',
  'playerName',
]);

/** Text that is the same in every language. */
export const ALLOWED = new Set([
  // The game's name.
  'Build Roulette',
  // An example room code.
  'K7QXM',
]);

export interface Violation {
  file: string;
  line: number;
  text: string;
}

const LETTER = /\p{L}/u;

function hasWords(text: string): boolean {
  // HTML entities (`&nbsp;`) are not words.
  const t = text
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return t !== '' && LETTER.test(t) && !ALLOWED.has(t);
}

/** The string literals an expression may evaluate to, at the top level of the expression. */
function literals(node: ts.Expression): ts.Node[] {
  if (ts.isParenthesizedExpression(node)) return literals(node.expression);
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [node];
  if (ts.isTemplateExpression(node)) return [node];
  if (ts.isConditionalExpression(node)) {
    return [...literals(node.whenTrue), ...literals(node.whenFalse)];
  }
  if (
    ts.isBinaryExpression(node) &&
    (node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
      node.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
      node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken)
  ) {
    return [...literals(node.left), ...literals(node.right)];
  }
  return [];
}

function literalText(node: ts.Node): string {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) {
    // Only the typed parts count: `${a} · ${b}` has no words of its own.
    return [node.head.text, ...node.templateSpans.map((s) => s.literal.text)].join(' ');
  }
  return '';
}

/** The violations in one TSX source. */
export function findHardcodedStrings(file: string, source: string): Violation[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: Violation[] = [];
  const report = (node: ts.Node, text: string) => {
    if (!hasWords(text)) return;
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    out.push({ file, line: line + 1, text: text.replace(/\s+/g, ' ').trim() });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isJsxText(node)) {
      report(node, node.text);
    } else if (ts.isJsxAttribute(node)) {
      const name = node.name.getText(sf);
      const init = node.initializer;
      if (TEXT_PROPS.has(name) && init) {
        if (ts.isStringLiteral(init)) report(init, init.text);
        else if (ts.isJsxExpression(init) && init.expression) {
          for (const lit of literals(init.expression)) report(lit, literalText(lit));
        }
      }
    } else if (
      ts.isJsxExpression(node) &&
      node.expression &&
      (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent))
    ) {
      for (const lit of literals(node.expression)) report(lit, literalText(lit));
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

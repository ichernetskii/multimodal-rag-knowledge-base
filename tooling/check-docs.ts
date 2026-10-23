import { existsSync, statSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { basename, dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = fileURLToPath(new URL('../', import.meta.url));
const excluded = new Set([
  '.git',
  '.idea',
  '.yarn',
  '.cache',
  '.venv',
  '.artifacts',
  'node_modules',
  'dist',
  'data',
  'coverage',
]);
const markdown = new Map<string, string>();
const errors: string[] = [];
async function collect(directory: string) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (excluded.has(entry.name) || entry.isSymbolicLink()) continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) await collect(path);
    else if (entry.isFile() && entry.name.endsWith('.md'))
      markdown.set(path, await readFile(path, 'utf8'));
  }
}
function prose(source: string) {
  return source.replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1[ \t]*$/gmu, '');
}
function anchors(source: string) {
  const result = new Set<string>();
  const counts = new Map<string, number>();
  for (const match of prose(source).matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gmu)) {
    const slug = match[1]!
      .replace(/\[([^\]]+)\]\([^)]+\)/gu, '$1')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}_\-\s]/gu, '')
      .replace(/\s/gu, '-');
    const count = counts.get(slug) ?? 0;
    counts.set(slug, count + 1);
    result.add(slug + (count ? '-' + count : ''));
  }
  return result;
}
function checkLink(file: string, destination: string) {
  if (/^[a-z][a-z\d+.-]*:/iu.test(destination) || destination.startsWith('//')) return;
  let path: string, anchor: string;
  try {
    const parts = destination.split('#', 2);
    path = decodeURIComponent(parts[0]!.split('?')[0]!);
    anchor = decodeURIComponent(parts[1] ?? '');
  } catch {
    errors.push(`${relative(root, file)}: invalid link ${destination}`);
    return;
  }
  const target = path ? resolve(dirname(file), path) : file;
  const location = relative(root, target);
  if (path.startsWith('/') || location.startsWith('..') || !existsSync(target)) {
    errors.push(`${relative(root, file)}: missing or non-project link ${destination}`);
    return;
  }
  if (anchor && statSync(target).isFile() && target.endsWith('.md')) {
    const content = markdown.get(target);
    if (!content || !anchors(content).has(anchor))
      errors.push(`${relative(root, file)}: missing section ${destination}`);
  }
}

await collect(root);
for (const [file, source] of markdown) {
  const companion =
    basename(file) === 'README.md'
      ? 'README.ru.md'
      : basename(file) === 'README.ru.md'
        ? 'README.md'
        : '';
  if (companion && !markdown.has(resolve(dirname(file), companion)))
    errors.push(`${relative(root, file)}: missing ${companion} companion`);
  const text = prose(source);
  for (const match of text.matchAll(
    /!?\[[^\]\n]*\]\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+"[^"]*")?\s*\)/gu,
  ))
    checkLink(file, match[1] ?? match[2]!);
  for (const match of text.matchAll(/^ {0,3}\[[^\]\n]+\]:\s*(?:<([^>]+)>|(\S+))/gmu))
    checkLink(file, match[1] ?? match[2]!);
}

const api = markdown.get(resolve(root, 'docs/API.md')) ?? '';
const contracts = ts.createSourceFile(
  'public.ts',
  await readFile(resolve(root, 'server/src/contracts/public.ts'), 'utf8'),
  ts.ScriptTarget.Latest,
  true,
);
const fields = contracts.statements
  .flatMap((statement) =>
    ts.isVariableStatement(statement) ? [...statement.declarationList.declarations] : [],
  )
  .find(
    (declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === 'actionFields',
  );
let initializer = fields?.initializer;
while (initializer && (ts.isAsExpression(initializer) || ts.isSatisfiesExpression(initializer)))
  initializer = initializer.expression;
if (!initializer || !ts.isObjectLiteralExpression(initializer))
  throw new Error('Cannot read actionFields from the public contract.');
const actions = new Set(
  initializer.properties.map((property) => {
    if (!property.name || !(ts.isStringLiteral(property.name) || ts.isIdentifier(property.name)))
      throw new Error('Unsupported action name in the public contract.');
    return property.name.text;
  }),
);
const documentedActions = new Set<string>();
const inputFields = new Map(
  initializer.properties.map((property) => {
    if (!ts.isPropertyAssignment(property) || !ts.isArrayLiteralExpression(property.initializer))
      throw new Error('Unsupported action fields in the public contract.');
    const name = property.name;
    if (!ts.isStringLiteral(name) && !ts.isIdentifier(name))
      throw new Error('Unsupported action name in the public contract.');
    return [
      name.text,
      property.initializer.elements
        .map((element) => {
          if (!ts.isStringLiteral(element)) throw new Error('Unsupported action input field.');
          return element.text;
        })
        .sort(),
    ];
  }),
);
for (const row of api.split('\n').filter((line) => line.startsWith('|'))) {
  const cell = row.split('|')[1]?.replaceAll('`', '').trim() ?? '';
  for (const action of cell.split(/\s+\/\s+/u)) {
    if (!/^[a-z][\w.]*$/u.test(action)) continue;
    if (!actions.has(action)) errors.push(`docs/API.md: unknown action ${action}`);
    if (documentedActions.has(action)) errors.push(`docs/API.md: repeated action ${action}`);
    documentedActions.add(action);
    const documentedFields = [...(row.split('|')[2] ?? '').matchAll(/`([^`]+)`/gu)]
      .map((match) => match[1]!)
      .sort();
    if (
      actions.has(action) &&
      JSON.stringify(documentedFields) !== JSON.stringify(inputFields.get(action))
    )
      errors.push(`docs/API.md: input fields differ from the contract for ${action}`);
  }
}
for (const action of actions)
  if (!documentedActions.has(action)) errors.push(`docs/API.md: undocumented action ${action}`);

const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>;
};
const development = markdown.get(resolve(root, 'docs/DEVELOPMENT.md')) ?? '';
for (const command of Object.keys(manifest.scripts))
  if (
    !development.includes('`yarn ' + command + '`') &&
    !development.includes('`yarn ' + command + ' ')
  )
    errors.push(`docs/DEVELOPMENT.md: undocumented script ${command}`);

const configuration = markdown.get(resolve(root, 'docs/CONFIGURATION.md')) ?? '';
const variables = new Set<string>();
for (const example of [
  '.env.example',
  'server/.env.example',
  'client/.env.example',
  'compose.env.example',
]) {
  const contents = await readFile(resolve(root, example), 'utf8');
  for (const match of contents.matchAll(/^(?:#\s*)?([A-Z][A-Z\d_]+)=/gmu)) {
    variables.add(match[1]!);
    if (!configuration.includes('`' + match[1]! + '`'))
      errors.push(`docs/CONFIGURATION.md: undocumented variable ${match[1]} from ${example}`);
  }
}
if (errors.length) {
  console.error(errors.join('\n'));
  process.exitCode = 1;
} else
  console.log(
    `Documentation: ${markdown.size} Markdown files, ${actions.size} actions, ${Object.keys(manifest.scripts).length} scripts, ${variables.size} environment variables checked.`,
  );

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import { actionFields } from '../src/contracts/public.js';

function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? sources(join(directory, entry.name))
      : /\.tsx?$/u.test(entry.name)
        ? [join(directory, entry.name)]
        : [],
  );
}
void test('client and server boundaries and runtime dependency graph', () => {
  const server = resolve('src'),
    client = resolve('../client/src');
  const files = [...sources(server), ...sources(client)];
  const graph = new Map<string, string[]>();
  for (const file of files) {
    const ast = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    const dependencies: string[] = [];
    for (const statement of ast.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
        continue;
      const specifier = statement.moduleSpecifier.text;
      if (file.startsWith(client))
        assert.ok(!specifier.startsWith('node:'), `Node dependency in client: ${file}`);
      if (!specifier.startsWith('.')) continue;
      const target = resolve(dirname(file), specifier.replace(/\.js$/u, '.ts'));
      const resolved = files.find(
        (candidate) =>
          candidate === target || candidate === target + '.ts' || candidate === target + '.tsx',
      );
      if (!resolved) continue;
      assert.equal(
        file.startsWith(client),
        resolved.startsWith(client),
        `Cross-workspace import: ${file} -> ${resolved}`,
      );
      if (file.includes('/domain/') || file.includes('/contracts/'))
        assert.ok(
          resolved.includes('/domain/') || resolved.includes('/contracts/'),
          `Domain depends on implementation: ${file}`,
        );
      const clause = statement.importClause;
      const typeOnly =
        clause?.isTypeOnly ||
        (!clause?.name &&
          clause?.namedBindings &&
          ts.isNamedImports(clause.namedBindings) &&
          clause.namedBindings.elements.every((element) => element.isTypeOnly));
      if (!typeOnly) dependencies.push(resolved);
    }
    graph.set(file, dependencies);
  }
  const visited = new Set<string>(),
    active = new Set<string>();
  function visit(file: string) {
    assert.ok(!active.has(file), `Runtime import cycle: ${[...active, file].join(' -> ')}`);
    if (visited.has(file)) return;
    active.add(file);
    for (const dependency of graph.get(file) ?? []) visit(dependency);
    active.delete(file);
    visited.add(file);
  }
  for (const file of files) visit(file);
});
void test('public action contract exactly matches feature action registrations', () => {
  const names: string[] = [];
  for (const file of sources(resolve('src/features'))) {
    const ast = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    function inspect(node: ts.Node) {
      if (
        ts.isPropertyDeclaration(node) &&
        node.name.getText(ast) === 'actions' &&
        node.initializer &&
        ts.isObjectLiteralExpression(node.initializer)
      ) {
        for (const property of node.initializer.properties) {
          assert.ok(ts.isPropertyAssignment(property));
          assert.ok(ts.isStringLiteral(property.name) || ts.isIdentifier(property.name));
          names.push(property.name.text);
        }
      }
      ts.forEachChild(node, inspect);
    }
    inspect(ast);
  }
  assert.equal(new Set(names).size, names.length, 'Duplicate action registration');
  assert.deepEqual(names.sort(), Object.keys(actionFields).sort());
});

void test('each workspace declares the external packages used by its runtime', () => {
  for (const workspace of ['.', '../client']) {
    const manifest = JSON.parse(readFileSync(resolve(workspace, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    for (const file of sources(resolve(workspace, 'src'))) {
      const ast = ts.createSourceFile(
        file,
        readFileSync(file, 'utf8'),
        ts.ScriptTarget.Latest,
        true,
      );
      for (const statement of ast.statements) {
        if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
          continue;
        const specifier = statement.moduleSpecifier.text;
        if (specifier.startsWith('.') || specifier.startsWith('node:')) continue;
        const parts = specifier.split('/'),
          name = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!;
        const clause = statement.importClause,
          typeOnly =
            clause?.isTypeOnly ||
            (!clause?.name &&
              clause?.namedBindings &&
              ts.isNamedImports(clause.namedBindings) &&
              clause.namedBindings.elements.every((element) => element.isTypeOnly));
        assert.ok(
          Object.hasOwn(manifest.dependencies, name) ||
            (typeOnly && Object.hasOwn(manifest.devDependencies, name)),
          `Undeclared runtime dependency ${name}: ${file}`,
        );
      }
    }
  }
});

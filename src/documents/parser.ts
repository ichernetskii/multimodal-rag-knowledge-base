import { unified } from 'unified';
import remarkParse from 'remark-parse';
import type { DocumentParser, DocumentSection, LoadedDocument } from '../core/contracts.js';

const markdownParser = unified().use(remarkParse);
function headingText(node: unknown): string {
  if (!node || typeof node !== 'object') return '';
  if ('value' in node && typeof node.value === 'string') return node.value;
  if ('alt' in node && typeof node.alt === 'string') return node.alt;
  if ('children' in node && Array.isArray(node.children))
    return node.children.map(headingText).join('');
  return '';
}

/** Preserve Markdown sections and treat TXT as a single section. */
export class TextDocumentParser implements DocumentParser {
  parse(document: LoadedDocument): DocumentSection[] {
    if (document.format === 'text')
      return document.text.trim()
        ? [
            {
              title: 'Text',
              text: document.text,
              startLine: 1,
              endLine: document.text.split('\n').length,
            },
          ]
        : [];
    const tree = markdownParser.parse(document.text);
    const definitions = new Map<string, { text: string; startLine: number; endLine: number }>();
    for (const node of tree.children) {
      if (node.type === 'definition' && node.position)
        definitions.set(node.identifier.toLowerCase(), {
          text: document.text.slice(node.position.start.offset, node.position.end.offset),
          startLine: node.position.start.line,
          endLine: node.position.end.line,
        });
    }
    const usedDefinitions = new Set<string>();
    let references = new Set<string>();
    const referenced = (node: unknown): void => {
      if (!node || typeof node !== 'object') return;
      if (
        'type' in node &&
        (node.type === 'linkReference' || node.type === 'imageReference') &&
        'identifier' in node &&
        typeof node.identifier === 'string'
      )
        references.add(node.identifier.toLowerCase());
      if ('children' in node && Array.isArray(node.children)) node.children.forEach(referenced);
    };
    const headings: string[] = [];
    const sections: DocumentSection[] = [];
    let current: DocumentSection = { title: 'Introduction', text: '', startLine: 1, endLine: 1 };
    const flush = () => {
      if (current.text.trim()) {
        const additions = [...references].flatMap((id) => {
          const definition = definitions.get(id);
          if (!definition) return [];
          usedDefinitions.add(id);
          return [definition.text];
        });
        sections.push({
          ...current,
          text: current.text + (additions.length ? '\n\n' + additions.join('\n') : ''),
        });
      }
      references = new Set<string>();
    };
    for (const node of tree.children) {
      if (node.type === 'heading') {
        flush();
        headings.length = node.depth - 1;
        headings[node.depth - 1] = headingText(node).trim();
        current = {
          title: headings.filter(Boolean).join(' → '),
          text: '',
          startLine: node.position?.start.line ?? 1,
          endLine: node.position?.end.line ?? 1,
        };
      } else if (node.type !== 'definition' && node.position) {
        referenced(node);
        const body = document.text.slice(node.position.start.offset, node.position.end.offset);
        current.text += `${current.text ? '\n\n' : ''}${body}`;
        current.endLine = node.position.end.line;
      }
    }
    flush();
    const unused = [...definitions]
      .filter(([id]) => !usedDefinitions.has(id))
      .map(([, value]) => value);
    if (unused.length)
      sections.push({
        title: 'References',
        text: unused.map((item) => item.text).join('\n'),
        startLine: Math.min(...unused.map((item) => item.startLine)),
        endLine: Math.max(...unused.map((item) => item.endLine)),
      });
    return sections;
  }
}

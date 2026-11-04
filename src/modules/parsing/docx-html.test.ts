import { describe, expect, it } from 'vitest';
import { readDocxHtml } from './docx-html.js';

describe('docx html reader', () => {
  it('marks Word headings and bold paragraphs', () => {
    const blocks = readDocxHtml(
      '<h1>Sample Candidate</h1><p><strong>Computer Systems Engineering</strong></p>' +
        '<h2>Experience</h2><p>Built <strong>REST</strong> APIs and services.</p>'
    );

    expect(blocks.map((block) => block.type === 'paragraph' && [block.text, block.heading, block.bold])).toEqual([
      ['Sample Candidate', true, false],
      ['Computer Systems Engineering', false, true],
      ['Experience', true, false],
      ['Built REST APIs and services.', false, false]
    ]);
  });

  it('marks paragraphs that are mostly italic', () => {
    const blocks = readDocxHtml(
      '<p><em>Arowwai Industries</em></p><p>Built <em>REST</em> APIs and services.</p>'
    );

    expect(blocks.map((block) => block.type === 'paragraph' && block.italic)).toEqual([true, false]);
  });

  it('keeps link targets that are hidden behind link text', () => {
    const [block] = readDocxHtml(
      '<p>Links: <a href="https://www.linkedin.com/in/sample">LinkedIn</a> · ' +
        '<a href="https://github.com/sample?tab=repositories&amp;q=api">GitHub</a></p>'
    );

    expect(block).toMatchObject({
      text: 'Links: LinkedIn · GitHub',
      links: ['https://www.linkedin.com/in/sample', 'https://github.com/sample?tab=repositories&q=api']
    });
  });

  it('reads list items, including nested ones, without losing text', () => {
    const blocks = readDocxHtml(
      '<ul><li>Built REST APIs<ul><li>Tracking service</li></ul></li><li>Improved queries</li></ul>'
    );

    expect(blocks.map((block) => block.type === 'paragraph' && block.text)).toEqual([
      'Built REST APIs',
      'Tracking service',
      'Improved queries'
    ]);
  });

  it('decodes HTML entities in text', () => {
    const [block] = readDocxHtml('<p>Policies &amp; Gates &lt;admin&gt; &quot;roles&quot;</p>');

    expect(block).toMatchObject({ text: 'Policies & Gates <admin> "roles"' });
  });

  it('joins the paragraphs of a table cell and keeps nested tables as cell text', () => {
    const [table] = readDocxHtml(
      '<table><tr><td><p>Senior Backend</p><p>Developer</p></td>' +
        '<td><table><tr><td><p>ABC</p></td><td><p>Company</p></td></tr></table></td></tr></table>'
    );

    expect(table).toEqual({
      type: 'table',
      index: 0,
      columns: null,
      rows: [['Senior Backend Developer', 'ABC Company']]
    });
  });

  it('numbers blocks in document order', () => {
    const blocks = readDocxHtml('<p>One</p><table><tr><td><p>Two</p></td></tr></table><p>Three</p>');

    expect(blocks.map((block) => [block.type, block.index])).toEqual([
      ['paragraph', 0],
      ['table', 1],
      ['paragraph', 2]
    ]);
  });
});

import { describe, expect, it } from 'vitest';
import { normalizeHeadingText, scoreHeading } from './heading-classifier.js';

function score(
  text: string,
  options: Partial<Parameters<typeof scoreHeading>[0]> = {}
) {
  return scoreHeading({
    text,
    height: 12,
    localBodyHeight: 12,
    bold: false,
    bullet: false,
    ...options
  });
}

describe('heading scoring', () => {
  it('normalizes complete candidate text', () => {
    expect(normalizeHeadingText('  WORK   EXPERIENCE:  ')).toBe('work experience');
  });

  it('confirms a common section with independent size support', () => {
    const result = score('work experience', { height: 18 });

    expect(result.role).toBe('section-heading');
    expect(result.signals.commonSection).toBe(true);
    expect(result.signals.largerThanBody).toBe(true);
  });

  it('keeps a body-sized dictionary match as a candidate', () => {
    const result = score('Publications');

    expect(result.role).toBe('heading-candidate');
    expect(result.signals.commonSection).toBe(true);
  });

  it.each([
    'Professional Experience',
    'Employment History',
    'Educational Background',
    'Professional Summary',
    'Technical Skills'
  ])('recognizes the common section variant %s', (text) => {
    expect(score(text).signals.commonSection).toBe(true);
  });

  it('does not use substring dictionary matches', () => {
    expect(score('Bachelor of Education').signals.commonSection).toBe(false);
  });

  it('increases repeated-style evidence per match up to a cap', () => {
    const options = { bold: true } as const;

    expect(score('Custom Heading', options).confidence).toBe(0.3);
    expect(score('Custom Heading', { ...options, repeatedStyleMatches: 1 }).confidence).toBe(0.45);
    expect(score('Custom Heading', { ...options, repeatedStyleMatches: 2 }).confidence).toBe(0.6);
    expect(score('Custom Heading', { ...options, repeatedStyleMatches: 3 }).confidence).toBe(0.65);
    expect(score('Custom Heading', { ...options, repeatedStyleMatches: 10 }).confidence).toBe(0.65);
  });

  it.each([
    'Sep 2020 - Present',
    'divya@example.com',
    'GPA: 3.7',
    'Built reliable services for customers around the world.'
  ])('rejects negative body evidence in %s', (text) => {
    expect(score(text).role).toBe('body');
  });
});

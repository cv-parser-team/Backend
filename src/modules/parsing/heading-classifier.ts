export type HeadingRole =
  | 'document-title'
  | 'document-subtitle'
  | 'section-heading'
  | 'entry-heading'
  | 'heading-candidate'
  | 'body';

export interface HeadingSignals {
  commonSection: boolean;
  largerThanBody: boolean;
  bold: boolean;
  headingCase: boolean;
  short: boolean;
  whitespaceAbove: boolean;
  repeatedStyle: boolean;
  bullet: boolean;
  date: boolean;
  contact: boolean;
  numericLabel: boolean;
  keyValue: boolean;
  longSentence: boolean;
}

export interface HeadingScoreInput {
  text: string;
  height: number;
  localBodyHeight: number;
  bold: boolean;
  bullet: boolean;
  whitespaceAbove?: boolean;
  repeatedStyle?: boolean;
}

export interface HeadingScore {
  role: Extract<HeadingRole, 'section-heading' | 'heading-candidate' | 'body'>;
  confidence: number;
  signals: HeadingSignals;
}

export const HEADING_SETTINGS = {
  commonSections: [
    'about',
    'academic background',
    'achievements',
    'awards',
    'certifications',
    'contact',
    'education',
    'educational background',
    'employment history',
    'experience',
    'interests',
    'languages',
    'objective',
    'profile',
    'professional experience',
    'professional summary',
    'projects',
    'publications',
    'references',
    'skills',
    'summary',
    'technical skills',
    'volunteering',
    'work experience',
    'work history'
  ],
  weights: {
    commonSection: 0.35,
    largerThanBody: 0.35,
    bold: 0.15,
    headingCase: 0.08,
    short: 0.07,
    whitespaceAbove: 0.15,
    repeatedStyle: 0.15,
    bullet: -0.45,
    date: -0.5,
    contact: -0.5,
    numericLabel: -0.35,
    keyValue: -0.3,
    longSentence: -0.4
  },
  largerHeightRatio: 1.15,
  shortWordCount: 5,
  longSentenceWordCount: 12,
  candidateThreshold: 0.35,
  sectionThreshold: 0.65
} as const;

const COMMON_SECTIONS = new Set<string>(HEADING_SETTINGS.commonSections);
const DATE = /(?:\b(?:19|20)\d{2}\b|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\b)/iu;
const CONTACT = /(?:@|https?:\/\/|www\.|\+?\d[\d ().-]{6,}\d)/iu;
const NUMERIC_LABEL = /^\s*\d+[.)]?\s+/u;
const KEY_VALUE = /^\s*[^:]{1,30}:\s*\S/u;

export function normalizeHeadingText(text: string): string {
  return text
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[\s\p{P}]+$/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

function hasHeadingCase(text: string): boolean {
  const letters = text.replace(/[^\p{L}]/gu, '');
  if (letters.length === 0) {
    return false;
  }
  const uppercase = letters === letters.toLocaleUpperCase();
  const words = text.trim().split(/\s+/u).filter(Boolean);
  const titleCase = words.every((word) => !/^\p{L}/u.test(word) || /^\p{Lu}/u.test(word));
  return uppercase || titleCase;
}

function roundConfidence(value: number): number {
  return Math.round(Math.max(0, Math.min(1, value)) * 100) / 100;
}

export function scoreHeading(input: HeadingScoreInput): HeadingScore {
  const normalized = normalizeHeadingText(input.text);
  const words = normalized.split(/\s+/u).filter(Boolean);
  const signals: HeadingSignals = {
    commonSection: COMMON_SECTIONS.has(normalized),
    largerThanBody:
      input.localBodyHeight > 0 &&
      input.height >= input.localBodyHeight * HEADING_SETTINGS.largerHeightRatio,
    bold: input.bold,
    headingCase: hasHeadingCase(input.text),
    short: words.length > 0 && words.length <= HEADING_SETTINGS.shortWordCount,
    whitespaceAbove: input.whitespaceAbove ?? false,
    repeatedStyle: input.repeatedStyle ?? false,
    bullet: input.bullet,
    date: DATE.test(normalized),
    contact: CONTACT.test(normalized),
    numericLabel: NUMERIC_LABEL.test(normalized),
    keyValue: KEY_VALUE.test(normalized),
    longSentence:
      words.length >= HEADING_SETTINGS.longSentenceWordCount || /[.!?]$/u.test(input.text.trim())
  };

  const confidence = roundConfidence(
    (Object.keys(signals) as (keyof HeadingSignals)[]).reduce(
      (total, signal) => total + (signals[signal] ? HEADING_SETTINGS.weights[signal] : 0),
      0
    )
  );
  const independentSupport =
    signals.largerThanBody || signals.bold || signals.whitespaceAbove || signals.repeatedStyle;
  const role =
    confidence >= HEADING_SETTINGS.sectionThreshold &&
    (!signals.commonSection || independentSupport)
      ? 'section-heading'
      : confidence >= HEADING_SETTINGS.candidateThreshold
        ? 'heading-candidate'
        : 'body';

  return { role, confidence, signals };
}

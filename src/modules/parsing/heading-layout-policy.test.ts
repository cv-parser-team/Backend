import { describe, expect, it } from 'vitest';
import { headingLayoutAction } from './heading-layout-policy.js';

describe('heading layout authority', () => {
  it.each([
    ['document-title', 0.75, 'header-boundary'],
    ['document-subtitle', 0.7, 'header-boundary'],
    ['section-heading', 0.8, 'section-boundary'],
    ['entry-heading', 0.7, 'entry-boundary']
  ] as const)('authorizes %s at its threshold', (role, confidence, action) => {
    expect(headingLayoutAction({ role, confidence })).toBe(action);
  });

  it.each([
    ['document-title', 0.74],
    ['document-subtitle', 0.69],
    ['section-heading', 0.79],
    ['entry-heading', 0.69],
    ['heading-candidate', 1],
    ['body', 1]
  ] as const)('does not authorize %s with confidence %s', (role, confidence) => {
    expect(headingLayoutAction({ role, confidence })).toBe('none');
  });
});

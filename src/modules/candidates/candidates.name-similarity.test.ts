import { describe, expect, it } from 'vitest';
import { compareNames } from './candidates.name-similarity.js';

describe('name similarity', () => {
  it.each([
    ['Northstar Labs', 'northstar labs'],
    ['Northstar Labs', 'Northstar Labs, Inc.'],
    ['Acme Corporation', 'ACME Corp.'],
    ['Smith & Sons Ltd', 'Smith and Sons'],
    ['DataSoft', 'Data Soft'],
    ['Université de Montréal', 'Universite de Montreal'],
    ["King's College London", 'Kings College London'],
    ['Sr. Backend Engineer', 'Senior Backend Engineer'],
    ['The University of Jordan', 'University of Jordan'],
    ['Dept. of Computer Science', 'Department of Computer Science']
  ])('treats %j and %j as the same name', (left, right) => {
    expect(compareNames(left, right)).toBe('same');
    expect(compareNames(right, left)).toBe('same');
  });

  it.each([
    // Reordered words
    ['University of Jordan', 'Jordan University'],
    ['Backend Engineer', 'Engineer, Backend'],
    // Typos
    ['Univeristy of Jordan', 'University of Jordan'],
    ['Northstar Labs', 'Nortstar Labs'],
    ['Cedar Systems', 'Cedar System'],
    // Initials
    ['MIT', 'Massachusetts Institute of Technology'],
    ['UCLA', 'University of California, Los Angeles'],
    ['UC Berkeley', 'University of California, Berkeley'],
    ['UoJ', 'University of Jordan'],
    ['CS', 'Computer Science'],
    ['IBM', 'International Business Machines'],
    ['AUB', 'American University of Beirut'],
    // Shortened words
    ['Comp. Science', 'Computer Science'],
    ['Univ. of Toronto', 'University of Toronto'],
    ['Info. Tech.', 'Information Technology'],
    ['Mech. Engineering', 'Mechanical Engineering']
  ])('flags %j and %j as similar', (left, right) => {
    expect(compareNames(left, right)).toBe('similar');
    expect(compareNames(right, left)).toBe('similar');
  });

  it.each([
    ['Northstar Labs', 'Southstar Labs'],
    ['Jordan University', 'Jordan University of Science and Technology'],
    ['University of California, Berkeley', 'University of California, Los Angeles'],
    ['UC Berkeley', 'UC Davis'],
    ['Computer Science', 'Computer Engineering'],
    ['Computer Science', 'Political Science'],
    ['Junior Developer', 'Developer'],
    ['Software Engineer', 'Software Engineering Manager'],
    ['Branch Office 12', 'Branch Office 13'],
    ['MIT', 'Michigan Institute of Technology of Arts'],
    ['Google', 'Microsoft'],
    ['Java', 'Lava'],
    ['', 'Northstar Labs'],
    ['...', 'Northstar Labs']
  ])('keeps %j and %j different', (left, right) => {
    expect(compareNames(left, right)).toBe('different');
    expect(compareNames(right, left)).toBe('different');
  });
});

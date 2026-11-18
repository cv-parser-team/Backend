import type { ClaimBody, CreateCandidateBody } from '../../modules/candidates/candidates.schemas.js';

// Demo accounts use a reserved test domain, so demo data can always be told
// apart from real data and removed without touching anything else.
export const DEMO_EMAIL_DOMAIN = 'demo.luminacv.test';

// One documented password for every demo account. Local demo data only.
export const DEMO_PASSWORD = 'Demo-Password-2026!';

export type DemoRole = 'candidate' | 'reviewer' | 'admin';

export interface DemoClaim {
  origin: 'manual' | 'extracted';
  status: 'accepted' | 'pending' | 'rejected';
  claim: ClaimBody;
  // What the claim shows in the demo, for the README and for testers.
  purpose: string;
}

// An extracted claim the AI could not complete, waiting in the review list.
export interface DemoReviewItem {
  claimType: ClaimBody['type'];
  fields: Record<
    string,
    {
      value?: string | string[];
      raw?: string;
      current?: boolean;
      confidence: number;
      sources: string[];
    }
  >;
  issues: { field: string | null; code: string; required: boolean }[];
  purpose: string;
}

export interface DemoAccount {
  name: string;
  email: string;
  role: DemoRole;
  profile?: CreateCandidateBody;
  claims?: DemoClaim[];
  // A CV uploaded by the candidate, shown as processed. Extracted claims and
  // review items come from it.
  document?: { filename: string; reviewItems: DemoReviewItem[] };
}

function email(localPart: string): string {
  return `${localPart}@${DEMO_EMAIL_DOMAIN}`;
}

const sara: DemoAccount = {
  name: 'Sara Haddad',
  email: email('sara'),
  role: 'candidate',
  profile: {
    fullName: 'Sara Haddad',
    headline: 'Backend Developer',
    summary: 'Backend developer building REST APIs and data pipelines with Node.js and PostgreSQL.',
    phone: '+962 79 000 0001',
    location: 'Amman, Jordan',
    contactEmail: 'sara.haddad@example.com',
    profileLinks: [{ label: 'GitHub', url: 'https://github.com/sara-haddad-demo' }]
  },
  claims: [
    {
      origin: 'manual',
      status: 'accepted',
      claim: { type: 'skill', values: { name: 'TypeScript' } },
      purpose: 'Accepted skill'
    },
    {
      origin: 'manual',
      status: 'accepted',
      claim: {
        type: 'employment',
        values: {
          employer: 'Aramex',
          jobTitle: 'Backend Developer',
          startDate: '2021-03',
          location: 'Amman',
          description: 'Built shipment tracking APIs with Node.js and PostgreSQL.',
          skills: ['Node.js', 'PostgreSQL']
        }
      },
      purpose: 'Current job, without an end date'
    },
    {
      origin: 'manual',
      status: 'accepted',
      claim: {
        type: 'education',
        values: {
          institution: 'University of Jordan',
          degree: 'Bachelor of Science',
          fieldOfStudy: 'Computer Science',
          startDate: '2016-09',
          endDate: '2020-06'
        }
      },
      purpose: 'Accepted education'
    },
    {
      origin: 'manual',
      status: 'accepted',
      claim: {
        type: 'certification',
        values: {
          title: 'AWS Certified Developer – Associate',
          issuer: 'Amazon Web Services',
          issueDate: '2023-05',
          expiryDate: '2026-05',
          credentialId: 'AWS-DEMO-12345'
        }
      },
      purpose: 'Certification with an expiry date'
    },
    {
      origin: 'manual',
      status: 'accepted',
      claim: { type: 'language', values: { name: 'Arabic', proficiency: 'Native' } },
      purpose: 'Language with proficiency'
    },
    {
      origin: 'manual',
      status: 'accepted',
      claim: {
        type: 'project',
        values: {
          name: 'Delivery Route Planner',
          description: 'Plans delivery routes from order locations.',
          role: 'Lead developer',
          url: 'https://example.com/route-planner',
          startDate: '2022',
          skills: ['TypeScript', 'Docker']
        }
      },
      purpose: 'Project with a year-only date'
    },
    {
      origin: 'extracted',
      status: 'rejected',
      claim: { type: 'skill', values: { name: 'Cobol' } },
      purpose: 'Extracted claim the candidate rejected; not exported'
    },
    {
      origin: 'extracted',
      status: 'pending',
      claim: {
        type: 'employment',
        values: { employer: 'Zain', jobTitle: 'Software Engineer', startDate: '2020-07', endDate: '2021-02' }
      },
      purpose: 'Extracted claim waiting for review; not exported'
    }
  ],
  document: { filename: 'sara-haddad-cv.docx', reviewItems: [] }
};

const omar: DemoAccount = {
  name: 'Omar Khalil',
  email: email('omar'),
  role: 'candidate',
  profile: {
    fullName: 'Omar Khalil',
    headline: 'Full Stack Developer',
    location: 'Irbid, Jordan'
  },
  claims: [
    {
      origin: 'manual',
      status: 'accepted',
      claim: { type: 'skill', values: { name: 'JavaScript' } },
      purpose: 'Normalization: exact canonical term'
    },
    {
      origin: 'manual',
      status: 'accepted',
      claim: { type: 'skill', values: { name: 'Postgres' } },
      purpose: 'Normalization: approved alias of PostgreSQL'
    },
    {
      origin: 'manual',
      status: 'accepted',
      claim: { type: 'skill', values: { name: 'Pyhton' } },
      purpose: 'Normalization: spelling correction to Python'
    },
    {
      origin: 'manual',
      status: 'accepted',
      claim: {
        type: 'employment',
        values: {
          employer: 'Careem',
          jobTitle: 'Server-side Engineer',
          startDate: '2022-01',
          description: 'Built REST APIs and database services.'
        }
      },
      purpose: 'Normalization: AI matching to Backend Developer'
    },
    {
      origin: 'manual',
      status: 'accepted',
      claim: {
        type: 'employment',
        values: {
          employer: 'Orange Jordan',
          jobTitle: 'Prodject Manager',
          startDate: '2019-02',
          endDate: '2021-12',
          description: 'Planned sprints and managed delivery for the billing team.'
        }
      },
      purpose: 'Normalization: ambiguous between Project and Product Manager, then AI'
    },
    {
      origin: 'manual',
      status: 'accepted',
      claim: {
        type: 'education',
        values: {
          institution: 'Jordan University of Science and Technology',
          degree: 'Bachelors in Computer Science',
          startDate: '2014-09',
          endDate: '2018-06'
        }
      },
      purpose: 'Normalization: AI matching to Bachelor of Science'
    },
    {
      origin: 'manual',
      status: 'accepted',
      claim: { type: 'skill', values: { name: 'Underwater Basket Weaving' } },
      purpose: 'Normalization: no term; stays unmatched for the candidate'
    },
    {
      origin: 'extracted',
      status: 'pending',
      claim: { type: 'skill', values: { name: 'JavaScript' } },
      purpose: 'Duplicate skill: formatting-equivalent values'
    },
    {
      origin: 'extracted',
      status: 'pending',
      claim: {
        type: 'employment',
        values: {
          employer: 'Careem',
          jobTitle: 'Server-side Engineer',
          startDate: '2022',
          location: 'Amman',
          description: 'Maintained payment and dispatch services.',
          skills: ['TypeScript', 'PostgreSQL']
        }
      },
      purpose: 'Duplicate employment: date precision, enrichment, and text conflict'
    },
    {
      origin: 'extracted',
      status: 'pending',
      claim: {
        type: 'education',
        values: {
          institution: 'Jordan University of Science and Technology',
          degree: 'Bachelors in Computer Science',
          fieldOfStudy: 'Software Engineering',
          startDate: '2014',
          endDate: '2018-07'
        }
      },
      purpose: 'Duplicate education: enrichment, date precision, and end-date conflict'
    },
    {
      origin: 'manual',
      status: 'accepted',
      claim: {
        type: 'certification',
        values: {
          title: 'AWS Certified Cloud Practitioner',
          issuer: 'Amazon Web Services',
          issueDate: '2023',
          credentialId: 'AWS-OMAR-001'
        }
      },
      purpose: 'Duplicate certification base claim'
    },
    {
      origin: 'extracted',
      status: 'pending',
      claim: {
        type: 'certification',
        values: {
          title: 'AWS Certified Cloud Practitioner',
          issuer: 'Amazon Web Services',
          issueDate: '2023-04',
          expiryDate: '2026-04',
          credentialId: 'AWS-OMAR-009'
        }
      },
      purpose: 'Duplicate certification: date precision, enrichment, and credential conflict'
    },
    {
      origin: 'manual',
      status: 'accepted',
      claim: { type: 'language', values: { name: 'Arabic', proficiency: 'Native' } },
      purpose: 'Duplicate language base claim'
    },
    {
      origin: 'extracted',
      status: 'pending',
      claim: { type: 'language', values: { name: 'Arabic', proficiency: 'Fluent' } },
      purpose: 'Duplicate language: proficiency conflict'
    },
    {
      origin: 'manual',
      status: 'accepted',
      claim: {
        type: 'project',
        values: {
          name: 'Merchant Analytics',
          description: 'Built dashboards for merchant performance.',
          url: 'https://example.com/merchant-analytics',
          startDate: '2023',
          skills: ['JavaScript']
        }
      },
      purpose: 'Duplicate project base claim'
    },
    {
      origin: 'extracted',
      status: 'pending',
      claim: {
        type: 'project',
        values: {
          name: 'Merchant Analytics',
          description: 'Created revenue and retention reports.',
          role: 'Lead developer',
          url: 'https://example.com/merchant-analytics',
          startDate: '2023-02',
          endDate: '2024',
          skills: ['TypeScript', 'PostgreSQL']
        }
      },
      purpose: 'Duplicate project: date precision, enrichment, array union, and text conflict'
    }
  ],
  document: {
    filename: 'omar-khalil-cv.docx',
    reviewItems: [
      {
        claimType: 'skill',
        fields: {
          name: { value: 'Kubernetes', confidence: 0.8, sources: ['L30'] }
        },
        issues: [{ field: null, code: 'invalid_item', required: false }],
        purpose: 'Structurally invalid recognized skill'
      },
      {
        claimType: 'employment',
        fields: {
          employer: { value: 'Example Telecom', confidence: 0.8, sources: ['L99'] },
          startDate: { value: '2020-01', confidence: 0.9, sources: ['L31'] }
        },
        issues: [
          { field: 'employer', code: 'invalid_source', required: true },
          { field: 'jobTitle', code: 'missing_job_title', required: true }
        ],
        purpose: 'Employment with an invalid source and a missing required title'
      },
      {
        claimType: 'education',
        fields: {
          institution: { value: 'Yarmouk University', confidence: 0.9, sources: ['L32'] },
          degree: { value: 'BSc', confidence: 0.9, sources: ['L32'] },
          startDate: { value: '2018-13', confidence: 0.7, sources: ['L33'] }
        },
        issues: [{ field: 'startDate', code: 'invalid_date', required: true }],
        purpose: 'Education with an invalid required date'
      },
      {
        claimType: 'certification',
        fields: {
          title: { value: 'Scrum Fundamentals', confidence: 0.9, sources: ['L34'] },
          issuer: { value: 'SCRUMstudy', confidence: 0.9, sources: ['L34'] }
        },
        issues: [{ field: 'issueDate', code: 'missing_issue_date', required: true }],
        purpose: 'Certification missing its required issue date'
      },
      {
        claimType: 'language',
        fields: {
          name: { value: 'x'.repeat(101), confidence: 0.6, sources: ['L35'] }
        },
        issues: [{ field: 'name', code: 'invalid_value', required: true }],
        purpose: 'Language with an invalid required value'
      },
      {
        claimType: 'project',
        fields: {
          name: { value: 'Scheduling Portal', confidence: 0.9, sources: ['L36'] },
          startDate: { raw: 'Spring 2024', confidence: 0.6, sources: ['L37'] }
        },
        issues: [{ field: 'startDate', code: 'missing_value', required: false }],
        purpose: 'Project with optional raw date text but no normalized value'
      },
      {
        claimType: 'project',
        fields: {
          name: { value: 'Billing Migration', confidence: 0.9, sources: ['L38'] },
          startDate: { value: '2024-06', confidence: 0.9, sources: ['L39'] },
          endDate: { value: '2024-03', confidence: 0.9, sources: ['L39'] }
        },
        issues: [{ field: 'endDate', code: 'invalid_date_order', required: false }],
        purpose: 'Project whose optional end date precedes its start date'
      }
    ]
  }
};

const lina: DemoAccount = {
  name: 'Lina Saleh',
  email: email('lina'),
  role: 'candidate',
  profile: {
    fullName: 'Lina Saleh',
    headline: 'Data Analyst',
    location: 'Zarqa, Jordan'
  },
  claims: [
    {
      origin: 'extracted',
      status: 'pending',
      claim: { type: 'skill', values: { name: 'SQL' } },
      purpose: 'Extracted skill waiting for review'
    },
    {
      origin: 'extracted',
      status: 'pending',
      claim: {
        type: 'employment',
        values: { employer: 'Arab Bank', jobTitle: 'Data Analyst', startDate: '2022-04' }
      },
      purpose: 'Extracted job waiting for review'
    },
    {
      origin: 'extracted',
      status: 'pending',
      claim: {
        type: 'education',
        values: { institution: 'Hashemite University', degree: 'BSc', startDate: '2017' }
      },
      purpose: 'Extracted education with an alias degree and a year-only date'
    }
  ],
  document: {
    filename: 'lina-saleh-cv.docx',
    reviewItems: [
      {
        claimType: 'employment',
        fields: {
          employer: { value: 'Zain Jordan', confidence: 0.9, sources: ['L8'] },
          startDate: { value: '2020-01', confidence: 0.8, sources: ['L8'] }
        },
        issues: [{ field: 'jobTitle', code: 'missing_job_title', required: true }],
        purpose: 'Job without a title; the candidate completes it'
      },
      {
        claimType: 'certification',
        fields: {
          title: { value: 'Google Data Analytics', confidence: 0.9, sources: ['L14'] },
          issuer: { value: 'Google', confidence: 0.9, sources: ['L14'] }
        },
        issues: [{ field: 'issueDate', code: 'missing_issue_date', required: true }],
        purpose: 'Certificate without an issue date'
      }
    ]
  }
};

export const DEMO_ACCOUNTS: DemoAccount[] = [
  sara,
  omar,
  lina,
  { name: 'Rami Reviewer', email: email('reviewer'), role: 'reviewer' },
  { name: 'Ahmad Admin', email: email('admin'), role: 'admin' }
];

import { CanonicalCategory } from './normalization.matching.js';

export interface SeedTerm {
  name: string;
  // Other ways of writing the same term. Related but different terms, such as
  // "Angular" and "AngularJS", are never aliases of each other, and neither
  // are words that can mean more than one term, such as "Node" or "PM".
  aliases: string[];
}

// The starting dictionary. Loading it again adds only what is missing, so it
// can grow over time.
export const SEED_DICTIONARY: Record<CanonicalCategory, SeedTerm[]> = {
  skill: [
    { name: 'JavaScript', aliases: ['JS', 'Java Script'] },
    { name: 'TypeScript', aliases: ['TS', 'Type Script'] },
    { name: 'Node.js', aliases: ['NodeJS', 'Node JS'] },
    { name: 'React', aliases: ['React.js', 'ReactJS', 'React JS'] },
    { name: 'Vue.js', aliases: ['Vue', 'VueJS', 'Vue JS'] },
    { name: 'Angular', aliases: [] },
    { name: 'Next.js', aliases: ['NextJS', 'Next JS'] },
    { name: 'Express', aliases: ['Express.js', 'ExpressJS'] },
    { name: 'NestJS', aliases: ['Nest.js', 'Nest JS'] },
    { name: 'Python', aliases: ['Python 3', 'Python3'] },
    { name: 'Django', aliases: [] },
    { name: 'Flask', aliases: [] },
    { name: 'FastAPI', aliases: ['Fast API'] },
    { name: 'Java', aliases: [] },
    { name: 'Spring Boot', aliases: ['SpringBoot'] },
    { name: 'Kotlin', aliases: [] },
    { name: 'C', aliases: [] },
    { name: 'C++', aliases: ['CPP'] },
    { name: 'C#', aliases: ['CSharp', 'C Sharp'] },
    { name: 'ASP.NET', aliases: ['ASP .NET', 'ASP NET'] },
    { name: 'PHP', aliases: [] },
    { name: 'Laravel', aliases: [] },
    { name: 'Go', aliases: ['Golang'] },
    { name: 'Rust', aliases: [] },
    { name: 'Ruby', aliases: [] },
    { name: 'Ruby on Rails', aliases: ['Rails', 'RoR'] },
    { name: 'Swift', aliases: [] },
    { name: 'Dart', aliases: [] },
    { name: 'Flutter', aliases: [] },
    { name: 'HTML', aliases: ['HTML5'] },
    { name: 'CSS', aliases: ['CSS3'] },
    { name: 'Tailwind CSS', aliases: ['TailwindCSS', 'Tailwind'] },
    { name: 'Bootstrap', aliases: [] },
    { name: 'jQuery', aliases: [] },
    { name: 'SQL', aliases: [] },
    { name: 'MySQL', aliases: ['My SQL'] },
    { name: 'PostgreSQL', aliases: ['Postgres', 'Postgre SQL'] },
    { name: 'Microsoft SQL Server', aliases: ['SQL Server', 'MSSQL', 'MS SQL'] },
    { name: 'SQLite', aliases: [] },
    { name: 'MongoDB', aliases: ['Mongo', 'Mongo DB'] },
    { name: 'Redis', aliases: [] },
    { name: 'REST APIs', aliases: ['REST', 'REST API', 'RESTful APIs', 'RESTful API'] },
    { name: 'GraphQL', aliases: [] },
    { name: 'Docker', aliases: [] },
    { name: 'Kubernetes', aliases: ['K8s'] },
    { name: 'Git', aliases: [] },
    { name: 'GitHub', aliases: [] },
    { name: 'GitLab', aliases: [] },
    { name: 'CI/CD', aliases: ['CI CD', 'CICD'] },
    { name: 'Jenkins', aliases: [] },
    { name: 'Linux', aliases: [] },
    { name: 'Amazon Web Services', aliases: ['AWS'] },
    { name: 'Microsoft Azure', aliases: ['Azure'] },
    { name: 'Google Cloud Platform', aliases: ['GCP', 'Google Cloud'] },
    { name: 'Machine Learning', aliases: ['ML'] },
    { name: 'Artificial Intelligence', aliases: ['AI'] },
    {
      name: 'Data Structures and Algorithms',
      aliases: ['DSA', 'Data Structures & Algorithms']
    },
    {
      name: 'Object-Oriented Programming',
      aliases: ['OOP', 'Object Oriented Programming']
    },
    { name: 'Agile', aliases: [] },
    { name: 'Scrum', aliases: [] },
    { name: 'Jira', aliases: [] },
    { name: 'Figma', aliases: [] },
    { name: 'Adobe Photoshop', aliases: ['Photoshop'] },
    { name: 'Microsoft Excel', aliases: ['Excel', 'MS Excel'] },
    { name: 'Microsoft Office', aliases: ['MS Office'] }
  ],
  job_title: [
    { name: 'Software Engineer', aliases: [] },
    { name: 'Software Developer', aliases: [] },
    { name: 'Backend Developer', aliases: ['Back-end Developer', 'Back End Developer'] },
    { name: 'Frontend Developer', aliases: ['Front-end Developer', 'Front End Developer'] },
    {
      name: 'Full Stack Developer',
      aliases: ['Full-stack Developer', 'Fullstack Developer']
    },
    { name: 'Web Developer', aliases: [] },
    { name: 'Mobile Developer', aliases: [] },
    { name: 'iOS Developer', aliases: [] },
    { name: 'Android Developer', aliases: [] },
    { name: 'DevOps Engineer', aliases: ['Dev Ops Engineer'] },
    { name: 'Data Scientist', aliases: [] },
    { name: 'Data Analyst', aliases: [] },
    { name: 'Machine Learning Engineer', aliases: ['ML Engineer'] },
    { name: 'QA Engineer', aliases: ['Quality Assurance Engineer'] },
    { name: 'UI/UX Designer', aliases: ['UX/UI Designer', 'UI UX Designer', 'UX UI Designer'] },
    { name: 'Project Manager', aliases: [] },
    { name: 'Product Manager', aliases: [] },
    { name: 'Team Lead', aliases: ['Team Leader'] },
    { name: 'Technical Lead', aliases: ['Tech Lead'] },
    { name: 'Systems Administrator', aliases: ['System Administrator', 'Sysadmin'] },
    { name: 'Database Administrator', aliases: ['DBA'] }
  ],
  degree: [
    { name: 'Bachelor of Science', aliases: ['BSc', 'B.Sc.', 'B.Sc', 'BS', 'B.S.'] },
    { name: 'Bachelor of Arts', aliases: ['BA', 'B.A.'] },
    { name: 'Bachelor of Engineering', aliases: ['BEng', 'B.Eng.', 'B.Eng'] },
    { name: 'Master of Science', aliases: ['MSc', 'M.Sc.', 'M.Sc', 'MS', 'M.S.'] },
    { name: 'Master of Arts', aliases: ['MA', 'M.A.'] },
    { name: 'Master of Engineering', aliases: ['MEng', 'M.Eng.'] },
    { name: 'Master of Business Administration', aliases: ['MBA'] },
    { name: 'Doctor of Philosophy', aliases: ['PhD', 'Ph.D.', 'Ph.D'] },
    { name: 'Associate Degree', aliases: ["Associate's Degree"] },
    { name: 'High School Diploma', aliases: [] }
  ]
};

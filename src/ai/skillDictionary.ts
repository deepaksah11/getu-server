/**
 * Known skill vocabulary used for deterministic keyword extraction when no AI
 * provider is available, and by the heuristic resume parser.
 */

export const KNOWN_LANGUAGES = [
  'JavaScript', 'TypeScript', 'Python', 'Java', 'C++', 'C#', 'C', 'Go', 'Golang', 'Rust',
  'Ruby', 'PHP', 'Swift', 'Kotlin', 'SQL', 'HTML', 'CSS', 'Bash', 'Shell', 'Dart', 'Scala', 'R',
  'Objective-C', 'Perl', 'MATLAB', 'Solidity', 'Elixir', 'Haskell', 'Lua', 'PL/SQL', 'Groovy',
];

export const KNOWN_FRAMEWORKS = [
  'React', 'React.js', 'Next.js', 'Node.js', 'Express', 'Express.js', 'Vue', 'Vue.js', 'Angular',
  'NestJS', 'Django', 'Flask', 'FastAPI', 'Spring', 'Spring Boot', 'ASP.NET', '.NET', 'Svelte',
  'Tailwind CSS', 'Tailwind', 'Bootstrap', 'Redux', 'GraphQL', 'REST APIs', 'REST', 'gRPC',
  'React Native', 'Flutter', 'Laravel', 'Rails', 'Ruby on Rails', 'Hibernate', 'jQuery',
  'Nuxt.js', 'Remix', 'Gatsby', 'Electron', 'Microservices', 'Kafka', 'RabbitMQ', 'Celery',
  'TensorFlow', 'PyTorch', 'Keras', 'scikit-learn', 'Pandas', 'NumPy', 'Spark', 'Hadoop',
  'Airflow', 'LangChain', 'OpenCV', 'Hugging Face',
];

export const KNOWN_DATABASES = [
  'PostgreSQL', 'Postgres', 'MySQL', 'MongoDB', 'Redis', 'SQLite', 'DynamoDB',
  'Oracle', 'Cassandra', 'Elasticsearch', 'Supabase', 'Firebase', 'MariaDB', 'Prisma',
  'SQL Server', 'Snowflake', 'BigQuery', 'Redshift', 'Neo4j', 'ClickHouse', 'Pinecone',
];

export const KNOWN_CLOUD_DEVOPS = [
  'AWS', 'Amazon Web Services', 'GCP', 'Google Cloud', 'Azure', 'Docker',
  'Kubernetes', 'Terraform', 'CI/CD', 'CI/CD Pipelines', 'Jenkins', 'GitHub Actions',
  'Linux', 'Nginx', 'Ansible', 'Helm', 'Prometheus', 'Grafana', 'Serverless', 'Lambda',
  'CloudFormation', 'GitLab CI', 'ArgoCD', 'Vercel', 'Heroku',
];

export const KNOWN_TOOLS = [
  'Git', 'GitHub', 'GitLab', 'JIRA', 'Postman', 'Vite', 'Webpack', 'Playwright',
  'Cypress', 'Jest', 'Vitest', 'Selenium', 'JUnit', 'Mocha', 'VS Code', 'Figma',
  'Excel', 'Power BI', 'Tableau', 'Looker', 'Salesforce', 'SAP', 'Photoshop', 'Illustrator',
];

export const KNOWN_DOMAIN_SKILLS = [
  'Machine Learning', 'Deep Learning', 'NLP', 'Computer Vision', 'Data Analysis', 'Data Science',
  'Data Engineering', 'ETL', 'Statistics', 'LLM', 'Generative AI', 'System Design',
  'Distributed Systems', 'Object-Oriented Programming', 'Data Structures', 'Algorithms',
  'Agile', 'Scrum', 'Unit Testing', 'Test Automation', 'Manual Testing', 'API Testing',
  'UI/UX', 'Responsive Design', 'SEO', 'Digital Marketing', 'Content Writing', 'Sales',
  'Business Development', 'Customer Success', 'Project Management', 'Product Management',
  'Communication', 'Leadership', 'Problem Solving',
];

export const ALL_KNOWN_SKILLS = [
  ...KNOWN_LANGUAGES,
  ...KNOWN_FRAMEWORKS,
  ...KNOWN_DATABASES,
  ...KNOWN_CLOUD_DEVOPS,
  ...KNOWN_TOOLS,
  ...KNOWN_DOMAIN_SKILLS,
];

/** Variants that should count as the same skill when comparing. */
const SKILL_ALIASES: Record<string, string> = {
  'react.js': 'react',
  reactjs: 'react',
  'node': 'node.js',
  nodejs: 'node.js',
  'express.js': 'express',
  'vue.js': 'vue',
  vuejs: 'vue',
  golang: 'go',
  postgres: 'postgresql',
  'amazon web services': 'aws',
  'google cloud': 'gcp',
  'rest': 'rest apis',
  'restful apis': 'rest apis',
  'ci/cd pipelines': 'ci/cd',
  tailwind: 'tailwind css',
  'next': 'next.js',
  nextjs: 'next.js',
  'ruby on rails': 'rails',
  'js': 'javascript',
  'ts': 'typescript',
  'ml': 'machine learning',
  'k8s': 'kubernetes',
};

export function canonicalSkill(skill: string): string {
  const lower = skill.trim().toLowerCase();
  return SKILL_ALIASES[lower] || lower;
}

function escapeRegex(value: string): string {
  return value.replace(/[-[\]{}()*+?.,\\^$|#\s/]/g, '\\$&');
}

/**
 * Skill names that are also ordinary English words ("excel at", "express interest",
 * "go above"). They only count when written with their capitalisation.
 */
const CASE_SENSITIVE_SKILLS = new Set([
  'C', 'R', 'Go', 'Express', 'Swift', 'Spring', 'Shell', 'Dart', 'Spark', 'Lambda',
  'Rails', 'Remix', 'Excel', 'Rust', 'Electron',
]);

/**
 * Word-boundary aware skill matching. Single letter skills ("C", "R") never match
 * inside "C++" / "R&D" style tokens.
 */
export function textMentionsSkill(text: string, skill: string): boolean {
  if (!text || !skill) return false;
  if (CASE_SENSITIVE_SKILLS.has(skill)) {
    return new RegExp(`(^|[^A-Za-z0-9+#&])${escapeRegex(skill)}([^A-Za-z0-9+#&]|$)`).test(text);
  }
  const pattern = new RegExp(`(^|[^A-Za-z0-9])${escapeRegex(skill)}(?![A-Za-z0-9])`, 'i');
  return pattern.test(text);
}

/** Returns dictionary skills mentioned in the text, de-duplicated by canonical form. */
export function extractSkillsFromText(text: string, extraVocabulary: string[] = []): string[] {
  const found = new Map<string, string>();
  for (const skill of [...extraVocabulary, ...ALL_KNOWN_SKILLS]) {
    if (skill.length <= 1 && !extraVocabulary.includes(skill)) continue;
    const canonical = canonicalSkill(skill);
    if (found.has(canonical)) continue;
    if (textMentionsSkill(text, skill)) {
      found.set(canonical, skill);
    }
  }
  return Array.from(found.values());
}

/** True when two skill names refer to the same thing (aliases and containment like "AWS" / "AWS Lambda"). */
export function skillsEquivalent(a: string, b: string): boolean {
  const ca = canonicalSkill(a);
  const cb = canonicalSkill(b);
  if (ca === cb) return true;
  if (ca.length < 3 || cb.length < 3) return false;
  return textMentionsSkill(ca, cb) || textMentionsSkill(cb, ca);
}

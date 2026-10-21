import { ResumeExtractionOutput } from './schemas.js';
import {
  ALL_KNOWN_SKILLS,
  KNOWN_LANGUAGES,
  KNOWN_FRAMEWORKS,
  KNOWN_DATABASES,
  KNOWN_CLOUD_DEVOPS,
  KNOWN_TOOLS,
  textMentionsSkill,
} from './skillDictionary.js';

/**
 * Extracts structured data from raw resume text using heuristics and regex.
 * STRICT RULE: NEVER inserts dummy data (no Jordan Lee, no CloudSphere, no fake schools).
 * If data is not present in the text, returns empty strings or empty arrays.
 */
export function extractStructuredResumeFromText(rawText: string): ResumeExtractionOutput {
  if (!rawText || !rawText.trim()) {
    return {
      full_name: '',
      email: '',
      phone: '',
      location: '',
      professional_summary: '',
      years_of_experience: 0,
      salary_expectation: '',
      notice_period_days: 0,
      skills: [],
      skills_categorized: { languages: [], frameworks: [], databases: [], cloud_devops: [], tools: [] },
      experience: [],
      education: [],
      projects: [],
      certifications: [],
    };
  }

  const text = rawText.replace(/\r\n/g, '\n');
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  // 1. Email extraction
  const emailMatch = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
  const email = emailMatch ? emailMatch[0].trim() : '';

  // 2. Phone extraction
  const phoneMatch = text.match(/(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}|\+?\d[\d\s-]{8,14}\d/);
  const phone = phoneMatch ? phoneMatch[0].trim() : '';

  // 3. URLs
  const linkedinMatch = text.match(/https?:\/\/(?:www\.)?linkedin\.com\/in\/[a-zA-Z0-9_-]+/i);
  const githubMatch = text.match(/https?:\/\/(?:www\.)?github\.com\/[a-zA-Z0-9_-]+/i);
  const portfolioMatch = text.match(/https?:\/\/(?!www\.linkedin|linkedin|www\.github|github)[a-zA-Z0-9.-]+\.[a-z]{2,}(?:\/[^\s]*)?/i);

  // 4. Candidate Name
  let fullName = '';
  // Check first 5 non-empty lines for candidate name
  for (let i = 0; i < Math.min(5, lines.length); i++) {
    const line = lines[i];
    // Skip if line has email, URL, phone number, or resume title
    if (
      line.includes('@') ||
      line.includes('http') ||
      line.toLowerCase().includes('resume') ||
      line.toLowerCase().includes('curriculum vitae') ||
      line.toLowerCase().includes('phone') ||
      line.toLowerCase().includes('email') ||
      line.toLowerCase().includes('summary') ||
      /\d{3}/.test(line)
    ) {
      continue;
    }
    // Candidate names typically have 2-4 words and reasonable length
    const words = line.split(/\s+/);
    if (words.length >= 2 && words.length <= 5 && line.length <= 40 && !/[;:,|]/.test(line)) {
      fullName = line;
      break;
    }
  }

  // Fallback: If not found, check email local part (e.g. john.doe@... -> John Doe)
  if (!fullName && email) {
    const localPart = email.split('@')[0];
    const cleaned = localPart.replace(/[._-]+/g, ' ').replace(/\d+/g, '').trim();
    if (cleaned.length >= 3) {
      fullName = cleaned
        .split(/\s+/)
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
        .join(' ');
    }
  }

  // 5. Location
  let location = '';
  const locMatch = text.match(/(?:Location|Address)?[:\s-]*([A-Z][a-zA-Z\s]+,\s*(?:[A-Z]{2}|[A-Z][a-zA-Z\s]+))/);
  if (locMatch && !locMatch[1].toLowerCase().includes('university') && !locMatch[1].toLowerCase().includes('school')) {
    location = locMatch[1].trim();
  }

  // 6. Section extraction helper
  const sectionHeaders = [
    'EXPERIENCE',
    'WORK EXPERIENCE',
    'PROFESSIONAL EXPERIENCE',
    'EMPLOYMENT HISTORY',
    'EDUCATION',
    'ACADEMIC BACKGROUND',
    'SKILLS',
    'TECHNICAL SKILLS',
    'PROJECTS',
    'PERSONAL PROJECTS',
    'CERTIFICATIONS',
    'SUMMARY',
    'PROFESSIONAL SUMMARY',
    'ABOUT ME',
    'OBJECTIVE',
  ];

  const sectionPositions: { name: string; index: number }[] = [];
  for (const header of sectionHeaders) {
    const regex = new RegExp(`(?:^|\\n)\\s*([#*=-]*\\s*${header}\\s*[:#*=-]*)\\s*(?:\\n|$)`, 'i');
    const match = text.match(regex);
    if (match && match.index !== undefined) {
      sectionPositions.push({ name: header, index: match.index });
    }
  }
  sectionPositions.sort((a, b) => a.index - b.index);

  function getSectionContent(headerNames: string[]): string {
    const pos = sectionPositions.find((p) => headerNames.includes(p.name));
    if (!pos) return '';
    const currentIndex = pos.index;
    const nextSection = sectionPositions.find((p) => p.index > currentIndex);
    const endIndex = nextSection ? nextSection.index : text.length;
    return text.substring(currentIndex, endIndex);
  }

  // 7. Professional Summary
  let summary = '';
  const summaryContent = getSectionContent(['SUMMARY', 'PROFESSIONAL SUMMARY', 'ABOUT ME', 'OBJECTIVE']);
  if (summaryContent) {
    const sLines = summaryContent.split('\n').slice(1).map((l) => l.trim()).filter((l) => l.length > 0);
    summary = sLines.join(' ').slice(0, 500);
  } else {
    // If no explicit summary header, look at intro text right after contact info
    const introLines = lines.slice(1, 6).filter(
      (l) =>
        !l.includes('@') &&
        !l.includes('http') &&
        !/\d{3}[-.\s]\d{3}/.test(l) &&
        l.length > 40
    );
    if (introLines.length > 0) {
      summary = introLines.join(' ').slice(0, 500);
    }
  }

  // 8. Skills
  const detectedSkillsSet = new Set<string>();
  // Match skills from dictionary across full text
  for (const skill of ALL_KNOWN_SKILLS) {
    if (skill.length <= 1) continue;
    if (textMentionsSkill(text, skill)) {
      detectedSkillsSet.add(skill);
    }
  }

  // Also parse explicit skills section lines (e.g. "Languages: JavaScript, TypeScript, Python")
  const skillsContent = getSectionContent(['SKILLS', 'TECHNICAL SKILLS']);
  if (skillsContent) {
    const items = skillsContent
      .replace(/^[^\n]*\n/, '') // remove header
      .split(/[,;|•\n]/)
      .map((s) => s.replace(/^[-*•]\s*/, '').trim())
      .filter((s) => s.length > 1 && s.length < 35 && !/skills|proficient/i.test(s));
    for (const item of items) {
      if (item && !item.includes(':')) {
        detectedSkillsSet.add(item);
      }
    }
  }

  const detectedSkills = Array.from(detectedSkillsSet);

  const categorized = {
    languages: detectedSkills.filter((s) => KNOWN_LANGUAGES.some((k) => k.toLowerCase() === s.toLowerCase())),
    frameworks: detectedSkills.filter((s) => KNOWN_FRAMEWORKS.some((k) => k.toLowerCase() === s.toLowerCase())),
    databases: detectedSkills.filter((s) => KNOWN_DATABASES.some((k) => k.toLowerCase() === s.toLowerCase())),
    cloud_devops: detectedSkills.filter((s) => KNOWN_CLOUD_DEVOPS.some((k) => k.toLowerCase() === s.toLowerCase())),
    tools: detectedSkills.filter((s) => KNOWN_TOOLS.some((k) => k.toLowerCase() === s.toLowerCase())),
  };

  // 9. Work Experience
  const expSection = getSectionContent([
    'EXPERIENCE',
    'WORK EXPERIENCE',
    'PROFESSIONAL EXPERIENCE',
    'EMPLOYMENT HISTORY',
  ]);

  const experience: Array<{
    company: string;
    role: string;
    period: string;
    location?: string;
    bullets: string[];
    technologies: string[];
  }> = [];

  if (expSection) {
    const expLines = expSection.split('\n').slice(1).map((l) => l.trim()).filter(Boolean);
    let currentEntry: {
      company: string;
      role: string;
      period: string;
      bullets: string[];
      technologies: string[];
    } | null = null;

    // Regex for date period like (2020 - 2023), (Jan 2021 - Present), (2022 - Current)
    const dateRegex = /(?:(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s*)?\b(20\d\d|19\d\d)\b\s*[-–—to]+\s*(?:(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s*)?(20\d\d|Present|Current|Now)/i;

    for (const line of expLines) {
      const dateMatch = line.match(dateRegex);
      const isBullet = /^[-*•–—]\s*/.test(line);

      if (dateMatch && !isBullet) {
        if (currentEntry && (currentEntry.company || currentEntry.role)) {
          experience.push(currentEntry);
        }
        const periodStr = dateMatch[0].trim();
        const nonDatePart = line.replace(dateMatch[0], '').replace(/[()|–—]/g, ' ').trim();
        // "Role, Company" / "Role at Company" / "Role | Company" / "Role @ Company"
        const parts = nonDatePart.split(/\s*(?:[–—,|@]|\s-\s|\bat\b)\s*/i).map((p) => p.trim()).filter(Boolean);

        let comp = '';
        let role = '';
        if (parts.length >= 2) {
          role = parts[0];
          comp = parts[1];
        } else if (parts.length === 1) {
          comp = parts[0];
        }

        currentEntry = {
          company: comp,
          role: role,
          period: periodStr,
          bullets: [],
          technologies: [],
        };
      } else if (isBullet && currentEntry) {
        const bulletText = line.replace(/^[-*•–—]\s*/, '').trim();
        if (bulletText.length > 5) {
          currentEntry.bullets.push(bulletText);
          // Check for technologies mentioned in the bullet
          for (const s of detectedSkills) {
            const re = new RegExp(`\\b${s.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&')}\\b`, 'i');
            if (re.test(bulletText) && !currentEntry.technologies.includes(s)) {
              currentEntry.technologies.push(s);
            }
          }
        }
      } else if (currentEntry && !isBullet && line.length > 5 && line.length < 80) {
        if (!currentEntry.role) {
          currentEntry.role = line;
        } else if (!currentEntry.company) {
          currentEntry.company = line;
        }
      }
    }

    if (currentEntry && (currentEntry.company || currentEntry.role)) {
      experience.push(currentEntry);
    }
  }

  // 10. Education
  const eduSection = getSectionContent(['EDUCATION', 'ACADEMIC BACKGROUND']);
  const education: Array<{
    institution: string;
    degree: string;
    field_of_study: string;
    graduation_year: string;
    gpa?: string;
  }> = [];

  if (eduSection) {
    const eduLines = eduSection.split('\n').slice(1).map((l) => l.trim()).filter(Boolean);
    let currentEdu: {
      institution: string;
      degree: string;
      field_of_study: string;
      graduation_year: string;
      gpa?: string;
    } | null = null;

    for (const line of eduLines) {
      const yearMatch = line.match(/\b(20\d\d|19\d\d)\b/);
      const degreeMatch = line.match(/\b(B\.?S\.?|B\.?A\.?|M\.?S\.?|M\.?A\.?|Ph\.?D\.?|Bachelor|Master|Doctor|B\.?Tech|M\.?Tech|Associate)\b/i);
      const isUni = /(University|College|Institute|School|Academy)/i.test(line);

      if (isUni) {
        if (currentEdu && (currentEdu.institution || currentEdu.degree)) {
          education.push(currentEdu);
        }
        currentEdu = {
          institution: line,
          degree: '',
          field_of_study: '',
          graduation_year: yearMatch ? yearMatch[1] : '',
        };
      } else if (degreeMatch && currentEdu) {
        currentEdu.degree = line;
        if (yearMatch && !currentEdu.graduation_year) {
          currentEdu.graduation_year = yearMatch[1];
        }
      } else if (currentEdu && yearMatch && !currentEdu.graduation_year) {
        currentEdu.graduation_year = yearMatch[1];
      } else if (!currentEdu && (isUni || degreeMatch)) {
        currentEdu = {
          institution: isUni ? line : '',
          degree: degreeMatch ? line : '',
          field_of_study: '',
          graduation_year: yearMatch ? yearMatch[1] : '',
        };
      }
    }

    if (currentEdu && (currentEdu.institution || currentEdu.degree)) {
      education.push(currentEdu);
    }
  }

  // 11. Projects
  const projSection = getSectionContent(['PROJECTS', 'PERSONAL PROJECTS']);
  const projects: Array<{
    title: string;
    description: string;
    bullets: string[];
    technologies: string[];
    link?: string;
  }> = [];

  if (projSection) {
    const projLines = projSection.split('\n').slice(1).map((l) => l.trim()).filter(Boolean);
    let currentProj: {
      title: string;
      description: string;
      bullets: string[];
      technologies: string[];
      link?: string;
    } | null = null;

    for (const line of projLines) {
      const isBullet = /^[-*•–—]\s*/.test(line);
      if (!isBullet && line.length < 60 && !line.includes('.')) {
        if (currentProj && currentProj.title) {
          projects.push(currentProj);
        }
        currentProj = {
          title: line,
          description: '',
          bullets: [],
          technologies: [],
        };
      } else if (isBullet && currentProj) {
        const bullet = line.replace(/^[-*•–—]\s*/, '').trim();
        currentProj.bullets.push(bullet);
        if (!currentProj.description) currentProj.description = bullet;
      }
    }
    if (currentProj && currentProj.title) {
      projects.push(currentProj);
    }
  }

  // 12. Calculate Years of Experience
  // Only employment periods count (education years must not inflate experience)
  let yearsOfExperience = 0;
  if (experience.length > 0) {
    const currentYear = new Date().getFullYear();
    const starts: number[] = [];
    const ends: number[] = [];
    for (const exp of experience) {
      const years = Array.from(exp.period.matchAll(/\b(19|20)\d{2}\b/g)).map((m) => parseInt(m[0], 10));
      if (years.length === 0) continue;
      starts.push(years[0]);
      ends.push(/present|current|now/i.test(exp.period) ? currentYear : years[years.length - 1]);
    }
    if (starts.length > 0) {
      yearsOfExperience = Math.max(0, Math.min(40, Math.max(...ends) - Math.min(...starts)));
    }
  }

  return {
    full_name: fullName,
    email,
    phone,
    location,
    professional_summary: summary,
    years_of_experience: yearsOfExperience,
    salary_expectation: '',
    notice_period_days: 0,
    skills: detectedSkills,
    skills_categorized: categorized,
    experience,
    education,
    projects,
    certifications: [],
    linkedin_url: linkedinMatch ? linkedinMatch[0] : undefined,
    github_url: githubMatch ? githubMatch[0] : undefined,
    portfolio_url: portfolioMatch ? portfolioMatch[0] : undefined,
  };
}

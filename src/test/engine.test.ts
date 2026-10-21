import { describe, it, expect } from 'vitest';
import { answerFromProfile, pickOption, parseAmount, normalizeQuestion } from '../ai/answerRules.js';
import { extractSkillsFromText, skillsEquivalent, textMentionsSkill } from '../ai/skillDictionary.js';
import { locationMatches, titleMatchScore, titleMatchesAny, htmlToText, relativeDateToIso } from '../automation/platforms/shared.js';
import { parseGuestSearch, parseGuestPosting } from '../automation/platforms/linkedin.js';
import { parseInternshalaListing } from '../automation/platforms/internshala.js';
import { profileReadiness, buildSearchQuery } from '../automation/readiness.js';
import { vault } from '../automation/security/vault.js';
import { extractConfirmationNumber } from '../automation/engine/submissionVerifier.js';
import { initialPreferences, initialProfile } from '../db/seed.js';
import { CandidateProfile } from '../types/index.js';
import { testCandidate } from './fixtures.js';
import { env } from '../config/env.js';

const priya = { ...initialProfile, ...testCandidate('u1') } as CandidateProfile;
const job = { title: 'Backend Engineer', company: 'Globex', platform: 'LinkedIn', skills: ['Node.js', 'Go'], locations: ['Bengaluru'] };
const ask = (question: string, kind: any = 'text', options?: string[]) =>
  answerFromProfile({ question, kind, options, required: true, job }, priya)?.answer ?? null;

describe('Profile answer rules', () => {
  it('fills identity and contact fields', () => {
    expect(ask('First name')).toBe('Priya');
    expect(ask('Last Name *')).toBe('Sharma');
    expect(ask('Full name')).toBe('Priya Sharma');
    expect(ask('Email address')).toBe('priya.sharma@testmail.dev');
    expect(ask('Mobile phone number')).toBe('+91 98765 43210');
    expect(ask('Phone number (10 digits, without country code)', 'number')).toBe('9876543210');
    expect(ask('Phone country code', 'select', ['United States (+1)', 'India (+91)'])).toBe('India (+91)');
    expect(ask('LinkedIn Profile')).toBe('https://linkedin.com/in/priya-sharma-dev');
    expect(ask('Current city')).toBe('Bengaluru');
  });

  it('answers experience questions honestly per skill', () => {
    expect(ask('How many years of work experience do you have with TypeScript?', 'number')).toBe('4');
    // Go is not in the profile: never claim experience with it
    expect(ask('How many years of experience do you have with Go?', 'number')).toBe('0');
    expect(ask('Total years of experience', 'number')).toBe('4');
    expect(ask('Do you have experience with React?', 'radio', ['Yes', 'No'])).toBe('Yes');
    expect(ask('Do you have experience with Kubernetes?', 'radio', ['Yes', 'No'])).toBe('No');
    expect(ask('Do you have 3+ years of experience with Node.js?', 'radio', ['Yes', 'No'])).toBe('Yes');
    expect(ask('Do you have 6+ years of experience with Node.js?', 'radio', ['Yes', 'No'])).toBe('No');
    expect(ask('Years of experience', 'select', ['0-1 years', '1-3 years', '3-5 years', '5+ years'])).toBe('3-5 years');
  });

  it('answers notice period, compensation and authorization', () => {
    expect(ask('What is your notice period?')).toBe('30 days');
    expect(ask('Notice period', 'select', ['Immediately', '15 days or less', '1 month', '2 months'])).toBe('1 month');
    expect(ask('Notice period (in days)', 'number')).toBe('30');
    expect(ask('Can you join within 15 days?', 'radio', ['Yes', 'No'])).toBe('No');
    expect(ask('Current CTC (in rupees)', 'number')).toBe('1200000');
    expect(ask('Expected CTC (LPA)', 'number')).toBe('18');
    expect(ask('Are you legally authorized to work in India?', 'radio', ['Yes', 'No'])).toBe('Yes');
    expect(ask('Will you now or in the future require visa sponsorship?', 'radio', ['Yes', 'No'])).toBe('No');
    expect(ask('Are you willing to relocate?', 'radio', ['Yes', 'No'])).toBe('No');
  });

  it('declines demographic questions and handles consent safely', () => {
    expect(ask('Gender', 'select', ['Male', 'Female', 'Decline to self-identify'])).toBe('Decline to self-identify');
    expect(ask('Veteran Status', 'select', ['I am a veteran', "I don't wish to answer"])).toBe("I don't wish to answer");
    expect(ask('I agree to the privacy policy', 'checkbox')).toBe('Yes');
    expect(ask('Do you agree to work night shifts?', 'radio', ['Yes', 'No'])).toBeNull();
    expect(ask('I consent to receiving text messages', 'radio', ['Yes - I consent', 'No - I do not consent'])).toBe('No - I do not consent');
  });

  it('answers education and employer questions', () => {
    expect(ask('Highest level of education', 'select', ['High School', "Bachelor's Degree", "Master's Degree"])).toBe("Bachelor's Degree");
    expect(ask('Graduation year')).toBe('2021');
    expect(ask('Do you have a bachelor\'s degree?', 'radio', ['Yes', 'No'])).toBe('Yes');
    expect(ask("Do you hold a master's degree?", 'radio', ['Yes', 'No'])).toBe('No');
    expect(ask('Current company')).toBe('Acme Analytics');
    expect(ask('Have you previously worked at Globex?', 'radio', ['Yes', 'No'])).toBe('No');
    expect(ask('How did you hear about us?', 'select', ['Referral', 'LinkedIn', 'Other'])).toBe('LinkedIn');
  });

  it('returns null for facts the profile does not contain', () => {
    expect(ask('Please enter your HackerRank profile ID')).toBeNull();
    expect(ask('Date of birth', 'date')).toBeNull();
    expect(ask('PIN code')).toBeNull();
  });

  it('does not misread "state" as a location in other questions', () => {
    expect(ask('Please state your expected CTC')).toBe('18 LPA');
  });

  it('picks options by synonyms, ranges and fuzzy text', () => {
    expect(pickOption(['Select...', 'Yes', 'No'], 'yes')).toBe('Yes');
    expect(pickOption(['Less than 1 year', '1-2 years', '3+ years'], '4')).toBe('3+ years');
    expect(pickOption(['India (भारत) +91', 'Indonesia +62'], 'India')).toBe('India (भारत) +91');
    expect(parseAmount('12 LPA')).toBe(1200000);
    expect(parseAmount('$165k')).toBe(165000);
    expect(normalizeQuestion('Notice period *')).toBe('notice period');
  });
});

describe('Skill vocabulary', () => {
  it('matches skills on word boundaries and respects case for ambiguous names', () => {
    expect(textMentionsSkill('Experience with Node.js and React', 'Node.js')).toBe(true);
    expect(textMentionsSkill('We go above and beyond', 'Go')).toBe(false);
    expect(textMentionsSkill('Services written in Go and Rust', 'Go')).toBe(true);
    expect(textMentionsSkill('Strong C++ skills', 'C')).toBe(false);
    expect(textMentionsSkill('You excel at communication', 'Excel')).toBe(false);
    expect(skillsEquivalent('React.js', 'React')).toBe(true);
    expect(skillsEquivalent('Postgres', 'PostgreSQL')).toBe(true);
    expect(skillsEquivalent('Java', 'JavaScript')).toBe(false);
    expect(extractSkillsFromText('Python, Django and AWS Lambda on Kubernetes')).toEqual(expect.arrayContaining(['Python', 'Django', 'AWS', 'Kubernetes']));
  });
});

describe('Search helpers', () => {
  it('scores titles with role synonyms', () => {
    expect(titleMatchScore('Senior Software Developer, Backend', 'Software Engineer')).toBe(1);
    expect(titleMatchScore('Frontend Engineer (React)', 'React Developer')).toBe(1);
    expect(titleMatchesAny('Account Executive - France', ['Software Engineer'])).toBe(false);
    expect(titleMatchesAny('Data Engineer', ['Data Analyst'])).toBe(false);
  });

  it('matches locations with aliases and rejects remote roles tied to other countries', () => {
    expect(locationMatches(['Bengaluru, Karnataka, India'], ['Bangalore'])).toBe(true);
    expect(locationMatches(['Remote - US'], ['Bengaluru', 'Remote'])).toBe(false);
    expect(locationMatches(['Austin, TX - Remote; Denver, CO - Remote'], ['Bengaluru', 'Remote'])).toBe(false);
    expect(locationMatches(['Remote - CA'], ['Pune', 'Remote'])).toBe(false);
    expect(locationMatches(['Remote, India'], ['Bengaluru', 'Remote'])).toBe(true);
    expect(locationMatches(['Remote'], ['Bengaluru', 'Remote'])).toBe(true);
    // Without an Indian home location, remote roles are not filtered by country
    expect(locationMatches(['Remote - US'], ['Remote'])).toBe(true);
    expect(locationMatches(['San Francisco, CA'], ['Bengaluru', 'Remote'])).toBe(false);
    expect(locationMatches(['Gurugram'], ['Gurgaon'])).toBe(true);
    expect(locationMatches(['Anywhere'], [])).toBe(true);
  });

  it('decodes entity-encoded HTML and relative dates', () => {
    expect(htmlToText('&lt;p&gt;Build &amp;amp; ship&lt;/p&gt;')).toBe('Build & ship');
    const iso = relativeDateToIso('3 days ago')!;
    expect(Math.round((Date.now() - Date.parse(iso)) / 86400000)).toBe(3);
  });

  it('builds the search from preferences, ignoring work-mode words as places', () => {
    const query = buildSearchQuery({ ...initialPreferences, preferred_roles: [], search_keywords: [], preferred_locations: ['Hybrid', 'Pune'], search_locations: [] }, priya);
    expect(query.keywords).toEqual(['Full Stack Engineer', 'Backend Engineer', 'Software Engineer']);
    expect(query.locations).toEqual(['Pune', 'Remote', 'Bengaluru']);
  });
});

describe('Platform parsers', () => {
  it('parses LinkedIn guest search cards and postings', () => {
    const html = `<li><div class="base-card" data-entity-urn="urn:li:jobPosting:123456"><a class="base-card__full-link" href="https://in.linkedin.com/jobs/view/x-123456"></a>
      <h3 class="base-search-card__title">  React Developer </h3><h4 class="base-search-card__subtitle"><a>Infosys</a></h4>
      <span class="job-search-card__location">Bengaluru, Karnataka, India</span><time class="job-search-card__listdate" datetime="2026-09-30"></time></div></li>`;
    const cards = parseGuestSearch(html);
    expect(cards).toEqual([{ id: '123456', title: 'React Developer', company: 'Infosys', location: 'Bengaluru, Karnataka, India', postedAt: new Date('2026-09-30').toISOString() }]);
    const posting = parseGuestPosting(
      `<div class="show-more-less-html__markup">We need <strong>React</strong> skills</div><h3 class="description__job-criteria-subheader">Seniority level</h3><span class="description__job-criteria-text">Entry level</span>`
    );
    expect(posting.description).toContain('We need React skills');
    expect(posting.criteria['Seniority level']).toBe('Entry level');
  });

  it('parses Internshala listing cards', () => {
    const html = `<div class="container-fluid individual_internship visibilityTrackerItem" internshipId="42" data-href='/job/detail/x-42'>
      <a class="job-title-href" href="/job/detail/x-42">Full Stack Developer</a><p class="company-name"> QuickHyre </p>
      <p class="row-1-item locations"><span><a>Work from home</a></span></p>
      <div class="row-1-item"><i class="ic-16-money"></i><span class="desktop"> ₹ 7,00,000 - 9,00,000 </span></div>
      <div class="row-1-item"><i class="ic-16-briefcase"></i><span>1 year(s)</span></div>
      <div class="about_job"><div class="text">Build web apps</div></div><div class='job_skill'>React</div><div class='job_skill'>Node.js</div>
      <div class="status-inactive"><i class="ic-16-reschedule"></i><span>2 days ago</span></div></div>`;
    const [job] = parseInternshalaListing(html, 'job');
    expect(job).toMatchObject({
      external_id: '42',
      title: 'Full Stack Developer',
      company: 'QuickHyre',
      locations: ['Remote'],
      work_mode: 'Remote',
      skills: ['React', 'Node.js'],
      application_url: 'https://internshala.com/job/detail/x-42',
    });
  });

  it('extracts confirmation numbers only when shown', () => {
    expect(extractConfirmationNumber('Thanks! Confirmation number: DEMO-AB12CD')).toBe('DEMO-AB12CD');
    expect(extractConfirmationNumber('Thank you for applying.')).toBeUndefined();
  });
});

describe('Readiness, vault and config', () => {
  it('blocks automation for sample or incomplete profiles', () => {
    expect(profileReadiness(priya).ready).toBe(true);
    const sample = profileReadiness({ ...priya, full_name: 'Jordan Lee', email: 'jordan.lee.dev@example.com' });
    expect(sample.ready).toBe(false);
    expect(sample.missing.join(' ')).toMatch(/sample data/);
    const empty = profileReadiness({ ...priya, phone: '', skills: [] });
    expect(empty.missing).toEqual(expect.arrayContaining(['Phone number', 'At least 3 skills']));
  });

  it('encrypts passwords with authenticated encryption', () => {
    const blob = vault.encrypt('s3cret-password');
    expect(JSON.stringify(blob)).not.toContain('s3cret');
    expect(vault.decrypt(blob)).toBe('s3cret-password');
    const tampered = { ...blob, data: Buffer.from('tampered!!').toString('base64') };
    expect(() => vault.decrypt(tampered)).toThrow();
  });

  it('parses boolean environment variables correctly', () => {
    // vitest.config sets BROWSER_HEADLESS="true" and SEED_DEMO_DATA="true"
    expect(env.BROWSER_HEADLESS).toBe(true);
    expect(env.SEED_DEMO_DATA).toBe(true);
    expect(env.AUTOMATION_ENABLED).toBe(false);
  });
});

describe('Rule regressions found in end-to-end runs', () => {
  it('answers yes/no questions that mention "country" with authorization facts, not the country name', () => {
    expect(ask('Are you legally authorized to work in this country?', 'radio', ['Yes', 'No'])).toBe('Yes');
    expect(ask('What is your current country of residence?', 'select', ['United States', 'India'])).toBe('India');
  });
});

describe('Answer quality issues found on live forms', () => {
  const abroadJob = { title: 'Software Engineer', company: 'OpenAI', platform: 'Ashby', skills: [], locations: ['San Francisco'] };
  const localJob = { title: 'SDE Intern', company: 'HackerRank', platform: 'Greenhouse', skills: [], locations: ['Onsite in Bangalore'] };
  const askFor = (j: any, question: string, kind: any = 'radio', options = ['Yes', 'No']) =>
    answerFromProfile({ question, kind, options, required: true, job: j }, priya)?.answer ?? null;

  it('picks the exact country instead of a longer name containing it', () => {
    expect(pickOption(['British Indian Ocean Territory +246', 'India +91', 'Indonesia +62'], 'India')).toBe('India +91');
  });

  it('is honest about working in another country', () => {
    expect(askFor(abroadJob, 'Are you authorized to work in the country where the job is located?')).toBe('No');
    expect(askFor(abroadJob, 'Will you now or in the future require sponsorship for employment visa status?')).toBe('Yes');
    expect(askFor(localJob, 'Are you legally authorized to work in this country?')).toBe('Yes');
    expect(askFor(null, 'Are you able to work from our US office three days per week?')).toBe('No');
    expect(askFor(localJob, 'Are you able to work from our Bangalore office, full-time for the entire duration?')).toBe('Yes');
    // "us" as a pronoun is not the United States
    expect(askFor(null, 'Are you legally authorized to work for us?')).toBe('Yes');
  });

  it('leaves legal waivers to the user and only uses GitHub as portfolio when required', () => {
    expect(askFor(null, 'I acknowledge that I have read and understood the Arbitration Agreement', 'checkbox', [])).toBeNull();
    expect(answerFromProfile({ question: 'Portfolio URL', kind: 'text', required: false }, priya)).toBeNull();
    expect(answerFromProfile({ question: 'Portfolio URL', kind: 'text', required: true }, priya)?.answer).toBe('https://github.com/priyasharma-dev');
  });

  it('does not treat availability questions that mention graduates as degree questions', () => {
    expect(askFor(localJob, 'Are you available for a 6-month internship? (open to 2027 graduates)')).toBeNull();
  });
});

describe('Availability wording', () => {
  it('only treats explicit "join within N" questions as notice-period checks', () => {
    expect(ask('Can you join within 15 days?', 'radio', ['Yes', 'No'])).toBe('No');
    expect(ask('Can you start in 2 months?', 'radio', ['Yes', 'No'])).toBe('Yes');
    expect(ask('Are you available to intern for a full-time, 6-month internship starting from Jan 5th 2027?', 'radio', ['Yes', 'No'])).toBeNull();
  });
});

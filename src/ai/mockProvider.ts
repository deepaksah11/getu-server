import { AICompletionOptions, AICompletionResult, AIProvider } from './provider.js';
import { extractStructuredResumeFromText } from './resumeParserHelper.js';

export type MockBehavior = 'valid' | 'malformed' | 'missing_fields' | 'hallucinated';

export class MockAIProvider implements AIProvider {
  public name = 'mock';
  public behavior: MockBehavior = 'valid';

  constructor(behavior: MockBehavior = 'valid') {
    this.behavior = behavior;
  }

  setBehavior(behavior: MockBehavior) {
    this.behavior = behavior;
  }

  async generateText(prompt: string, _options?: AICompletionOptions): Promise<AICompletionResult> {
    const latencyMs = 80;

    if (this.behavior === 'malformed') {
      return {
        text: '{"error": "unterminated string literal, invalid json...',
        inputTokens: 120,
        outputTokens: 20,
        latencyMs,
        model: 'mock-model',
      };
    }

    if (this.behavior === 'missing_fields') {
      return {
        text: JSON.stringify({ some_random_field: 123 }),
        inputTokens: 120,
        outputTokens: 20,
        latencyMs,
        model: 'mock-model',
      };
    }

    // Check what kind of prompt this is
    if (prompt.includes('extract requirements from this Job Description') || prompt.includes('JD_ANALYSIS')) {
      return {
        text: JSON.stringify({
          job_title: 'Senior Full Stack Developer (Node.js & React)',
          required_skills: ['TypeScript', 'Node.js', 'PostgreSQL', 'React', 'Docker'],
          preferred_skills: ['Redis', 'Kubernetes', 'AWS', 'GraphQL'],
          experience_required: '5+ years',
          education_required: "Bachelor's degree in Computer Science or related field",
          responsibilities: [
            'Design and architect scalable backend microservices in Node.js/TypeScript',
            'Develop responsive, accessible UI features using React',
            'Optimize PostgreSQL relational queries and implement Redis caching',
            'Collaborate on system design, code reviews, and DevOps automation',
          ],
          technical_requirements: ['Node.js', 'TypeScript', 'PostgreSQL', 'Docker', 'REST APIs'],
          soft_skills: ['Communication', 'Leadership', 'Cross-functional Collaboration'],
          location: ['Remote', 'San Francisco', 'Bangalore'],
          work_mode: 'Remote',
          salary_range: '$150,000 - $185,000',
          eligibility_notes: 'Candidate should have minimum 4 years relevant experience with Node.js and TypeScript.',
          keywords: ['Node.js', 'TypeScript', 'PostgreSQL', 'React', 'Docker', 'Redis', 'Microservices', 'Distributed Systems'],
          detected_questions: [
            { question: 'How many years of experience do you have with Node.js and TypeScript?', type: 'experience', is_required: true },
            { question: 'What is your current notice period?', type: 'notice_period', is_required: true },
            { question: 'What are your salary expectations?', type: 'salary', is_required: true },
            { question: 'Are you legally authorized to work in this location?', type: 'yes_no', is_required: true },
          ],
        }),
        inputTokens: 350,
        outputTokens: 280,
        latencyMs,
        model: 'mock-model',
      };
    }

    if (prompt.includes('tailor this resume') || prompt.includes('RESUME_TAILORING')) {
      const skills = this.behavior === 'hallucinated'
        ? [
            { category: 'Hallucinated Skills', items: ['Cobol 1974', 'Unreal Engine 5', 'Quantum Computing Q#'] },
          ]
        : [
            { category: 'Core Backend & Architecture', items: ['TypeScript', 'Node.js', 'PostgreSQL', 'Redis', 'System Design'] },
            { category: 'Frontend & APIs', items: ['React', 'REST APIs', 'GraphQL', 'Express.js'] },
            { category: 'Cloud & Infrastructure', items: ['Docker', 'AWS', 'CI/CD Pipelines', 'Playwright'] },
          ];

      return {
        text: JSON.stringify({
          tailored_summary:
            'Staff-level Full Stack & Backend Engineer with 7+ years of experience designing scalable distributed systems in Node.js and TypeScript. Specialized in high-throughput PostgreSQL databases, Redis caching layers, and responsive React architectures.',
          highlighted_skills: skills,
          tailored_experience: [
            {
              company: 'HyperScale Tech',
              role: 'Senior Software Engineer',
              period: '2022-03 - Present',
              location: 'San Francisco, CA (Remote)',
              bullets: [
                'Architected asynchronous job queue in Node.js processing 12M+ background tasks daily with 99.98% reliability.',
                'Engineered distributed Redis caching tier slashing PostgreSQL database query load by 54% during peak spikes.',
                'Mentored 6 engineers in TypeScript best practices, design patterns, and automated end-to-end testing with Playwright.',
              ],
              technologies: ['Node.js', 'TypeScript', 'PostgreSQL', 'Redis', 'Docker', 'AWS'],
            },
            {
              company: 'CloudFlow Systems',
              role: 'Full Stack Engineer',
              period: '2019-06 - 2022-02',
              location: 'San Francisco, CA',
              bullets: [
                'Built full-stack React and Express workflow designer used by 45,000+ active enterprise users.',
                'Designed normalized PostgreSQL schemas with strict indexing and row-level partitioning for multi-tenant data.',
              ],
              technologies: ['React', 'TypeScript', 'Node.js', 'PostgreSQL', 'Docker'],
            },
          ],
          tailored_projects: [
            {
              title: 'DistriQueue - High-Throughput Event Broker',
              description: 'Distributed lightweight message queue built on Node.js and Redis with at-least-once delivery guarantees.',
              bullets: [
                'Achieved throughput of 45,000 ops/sec per single worker node with sub-5ms latency.',
                'Implemented deterministic dead-letter queue recovery and exponential backoff retry mechanisms.',
              ],
              technologies: ['TypeScript', 'Node.js', 'Redis', 'Docker'],
              link: 'https://github.com/alexchen/distriqueue',
            },
          ],
          keywords_incorporated: ['TypeScript', 'Node.js', 'PostgreSQL', 'Redis', 'React', 'Docker'],
          rationale: 'Reordered core backend skills to match the job description priorities and highlighted high-throughput experience.',
        }),
        inputTokens: 520,
        outputTokens: 410,
        latencyMs,
        model: 'mock-model',
      };
    }

    if (prompt.includes('answer these application questions') || prompt.includes('QUESTION_ANSWERING')) {
      const questionLines = prompt
        .split('\n')
        .filter((l) => /^\d+\.\s+\[Type:/.test(l.trim()));

      const answers = questionLines.map((line) => {
        const qMatch = line.match(/^\d+\.\s+\[Type:\s*([^\]]+)\]\s*(.+)$/);
        const qType = qMatch ? qMatch[1].trim() : 'general';
        const qText = qMatch ? qMatch[2].trim() : line.trim();

        let ans = 'Yes';
        let field = 'candidate_profile';

        if (qType === 'experience' || qText.toLowerCase().includes('years')) {
          ans = 'I have 7.5 years of professional software engineering experience.';
          field = 'candidate_profile.years_of_experience';
        } else if (qType === 'notice_period' || qText.toLowerCase().includes('notice')) {
          ans = 'My notice period is 15 days.';
          field = 'candidate_profile.notice_period_days';
        } else if (qType === 'salary' || qText.toLowerCase().includes('salary')) {
          ans = '$165,000 - $190,000 per year.';
          field = 'candidate_profile.salary_expectation';
        } else if (qType === 'yes_no') {
          ans = 'Yes';
          field = 'candidate_profile.work_authorization';
        }

        return {
          question: qText,
          answer: ans,
          is_factual: true,
          source_field: field,
          confidence_score: 1.0,
        };
      });

      return {
        text: JSON.stringify({
          answers:
            answers.length > 0
              ? answers
              : [
                  {
                    question: 'How many years of experience do you have with Node.js and TypeScript?',
                    answer: 'I have 7.5 years of professional experience with Node.js and TypeScript.',
                    is_factual: true,
                    source_field: 'candidate_profile.years_of_experience',
                    confidence_score: 1.0,
                  },
                ],
        }),
        inputTokens: 290,
        outputTokens: 180,
        latencyMs,
        model: 'mock-model',
      };
    }

    if (prompt.includes('RESUME_EXTRACTION') || prompt.includes('Extract all structured information from this resume')) {
      // Extract the actual raw resume text passed in the prompt
      let resumeText = prompt;
      const rawTextMatch = prompt.match(/RAW RESUME TEXT:\s*"""([\s\S]*?)"""/);
      if (rawTextMatch && rawTextMatch[1]) {
        resumeText = rawTextMatch[1].trim();
      }

      const extracted = extractStructuredResumeFromText(resumeText);

      return {
        text: JSON.stringify(extracted),
        inputTokens: Math.ceil(prompt.length / 4),
        outputTokens: Math.ceil(JSON.stringify(extracted).length / 4),
        latencyMs,
        model: 'mock-model',
      };
    }

    // Default generic valid response
    return {
      text: JSON.stringify({ status: 'ok', data: 'Processed successfully' }),
      inputTokens: 100,
      outputTokens: 50,
      latencyMs,
      model: 'mock-model',
    };
  }
}

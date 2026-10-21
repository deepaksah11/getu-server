import { describe, it, expect } from 'vitest';
import path from 'path';
import fs from 'fs';
import { atsChecker } from '../resumes/atsChecker.js';
import { pdfGenerator } from '../resumes/pdfGenerator.js';
import { docxGenerator } from '../resumes/docxGenerator.js';
import { initialProfile, initialMasterResume, initialJobs } from '../db/seed.js';
import { paths } from '../config/paths.js';

describe('Resume Engine & ATS Evaluation', () => {
  it('should score high ATS compatibility for well-aligned resume', () => {
    const job = initialJobs[0];
    const result = atsChecker.evaluate(initialMasterResume.content_json, job);

    expect(result.score).toBeGreaterThanOrEqual(70);
    expect(result.keyword_coverage).toBeGreaterThanOrEqual(65);
    expect(result.matched_keywords).toContain('TypeScript');
    expect(result.matched_keywords).toContain('Node.js');
    expect(result.formatting_score).toBe(100);
  });

  it('should detect missing keywords and generate actionable issues', () => {
    const jobWithMissing = {
      ...initialJobs[0],
      skills: ['Rust', 'Elixir', 'GCP', 'PostgreSQL'],
      requirements: ['Rust', 'Elixir', 'GCP', 'PostgreSQL'],
    };

    const result = atsChecker.evaluate(initialMasterResume.content_json, jobWithMissing);
    expect(result.missing_keywords).toContain('Rust');
    expect(result.missing_keywords).toContain('Elixir');
    expect(result.score).toBeLessThan(80);
  });

  it('should successfully generate an ATS Classic PDF resume file', async () => {
    const testPdfPath = path.join(paths.resumesDir, 'test_ats_classic.pdf');
    await pdfGenerator.generateResumePDF(
      initialProfile,
      initialMasterResume.content_json,
      'ats_classic',
      testPdfPath
    );

    expect(fs.existsSync(testPdfPath)).toBe(true);
    const stats = fs.statSync(testPdfPath);
    expect(stats.size).toBeGreaterThan(1000); // Valid PDF artifact generated
  });

  it('should successfully generate a Modern Pro DOCX resume file', async () => {
    const testDocxPath = path.join(paths.resumesDir, 'test_modern_pro.docx');
    await docxGenerator.generateResumeDOCX(
      initialProfile,
      initialMasterResume.content_json,
      testDocxPath
    );

    expect(fs.existsSync(testDocxPath)).toBe(true);
    const stats = fs.statSync(testDocxPath);
    expect(stats.size).toBeGreaterThan(1000); // Valid Word document generated
  });
});

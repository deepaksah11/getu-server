import { Document, HeadingLevel, Packer, Paragraph, TextRun } from 'docx';
import fs from 'fs/promises';
import path from 'path';
import { CandidateProfile, MasterResumeContent } from '../types/index.js';

export class DOCXGenerator {
  public async generateResumeDOCX(
    profile: CandidateProfile,
    resume: MasterResumeContent,
    outputPath: string
  ): Promise<string> {
    await fs.mkdir(path.dirname(outputPath), { recursive: true });

    const paragraphs: Paragraph[] = [];

    // 1. Header (Name & Contact)
    paragraphs.push(
      new Paragraph({
        heading: HeadingLevel.TITLE,
        children: [
          new TextRun({
            text: profile.full_name,
            bold: true,
            size: 32,
            color: '0F172A',
          }),
        ],
      }),
      new Paragraph({
        children: [
          new TextRun({
            text: [profile.email, profile.phone, profile.location, profile.linkedin_url, profile.github_url, profile.portfolio_url]
              .filter(Boolean)
              .join('  |  '),
            size: 19,
            color: '475569',
          }),
        ],
      }),
      new Paragraph({ children: [] })
    );

    // 2. Summary
    if (resume.summary) {
      paragraphs.push(
        new Paragraph({
          heading: HeadingLevel.HEADING_1,
          children: [
            new TextRun({
              text: 'PROFESSIONAL SUMMARY',
              bold: true,
              size: 24,
              color: '1E293B',
            }),
          ],
        }),
        new Paragraph({
          children: [
            new TextRun({
              text: resume.summary,
              size: 20,
            }),
          ],
        }),
        new Paragraph({ children: [] })
      );
    }

    // 3. Technical Skills
    if (resume.skills && resume.skills.length > 0) {
      paragraphs.push(
        new Paragraph({
          heading: HeadingLevel.HEADING_1,
          children: [
            new TextRun({
              text: 'TECHNICAL SKILLS',
              bold: true,
              size: 24,
              color: '1E293B',
            }),
          ],
        })
      );

      for (const cat of resume.skills) {
        paragraphs.push(
          new Paragraph({
            children: [
              new TextRun({ text: `${cat.category}: `, bold: true, size: 20 }),
              new TextRun({ text: cat.items.join(', '), size: 20 }),
            ],
          })
        );
      }
      paragraphs.push(new Paragraph({ children: [] }));
    }

    // 4. Experience
    if (resume.experience && resume.experience.length > 0) {
      paragraphs.push(
        new Paragraph({
          heading: HeadingLevel.HEADING_1,
          children: [
            new TextRun({
              text: 'WORK EXPERIENCE',
              bold: true,
              size: 24,
              color: '1E293B',
            }),
          ],
        })
      );

      for (const exp of resume.experience) {
        paragraphs.push(
          new Paragraph({
            children: [
              new TextRun({ text: exp.role, bold: true, size: 22 }),
              new TextRun({ text: ` — ${exp.company} (${exp.period})`, size: 20, color: '64748B' }),
            ],
          })
        );

        for (const bullet of exp.bullets) {
          paragraphs.push(
            new Paragraph({
              bullet: { level: 0 },
              children: [new TextRun({ text: bullet, size: 20 })],
            })
          );
        }
      }
      paragraphs.push(new Paragraph({ children: [] }));
    }

    // 5. Education
    if (resume.education && resume.education.length > 0) {
      paragraphs.push(
        new Paragraph({
          heading: HeadingLevel.HEADING_1,
          children: [
            new TextRun({
              text: 'EDUCATION',
              bold: true,
              size: 24,
              color: '1E293B',
            }),
          ],
        })
      );

      for (const edu of resume.education) {
        paragraphs.push(
          new Paragraph({
            children: [
              new TextRun({ text: `${edu.degree}, ${edu.institution}`, bold: true, size: 20 }),
              new TextRun({ text: ` (${edu.year})`, size: 20, color: '64748B' }),
            ],
          })
        );
      }
    }

    const doc = new Document({
      sections: [{ children: paragraphs }],
    });

    const buffer = await Packer.toBuffer(doc);
    await fs.writeFile(outputPath, buffer);

    return outputPath;
  }
}

export const docxGenerator = new DOCXGenerator();

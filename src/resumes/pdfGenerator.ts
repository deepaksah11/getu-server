import PDFDocument from 'pdfkit';
import fs from 'fs/promises';
import { createWriteStream } from 'fs';
import path from 'path';
import { CandidateProfile, MasterResumeContent } from '../types/index.js';

export class PDFGenerator {
  public async generateResumePDF(
    profile: CandidateProfile,
    resume: MasterResumeContent,
    templateId: 'ats_classic' | 'modern_pro' | 'backend_dev',
    outputPath: string
  ): Promise<string> {
    await fs.mkdir(path.dirname(outputPath), { recursive: true });

    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({
        size: 'LETTER',
        margins: { top: 36, bottom: 36, left: 40, right: 40 },
        info: {
          Title: `${profile.full_name} - Resume`,
          Author: profile.full_name,
          Subject: 'Job Application Resume',
        },
      });

      const writeStream = doc.pipe(createWriteStream(outputPath));

      writeStream.on('finish', () => resolve(outputPath));
      writeStream.on('error', reject);

      const isClassic = templateId === 'ats_classic';
      const isModern = templateId === 'modern_pro';

      const primaryFont = isClassic ? 'Times-Roman' : 'Helvetica';
      const boldFont = isClassic ? 'Times-Bold' : 'Helvetica-Bold';
      const accentColor = isModern ? '#0284c7' : '#1e293b';

      // --- HEADER ---
      doc.font(boldFont).fontSize(20).fillColor(accentColor).text(profile.full_name, { align: 'center' });
      doc.moveDown(0.2);

      const contactLine = [profile.email, profile.phone, profile.location].filter(Boolean).join('  |  ');
      doc.font(primaryFont).fontSize(9.5).fillColor('#475569').text(contactLine, { align: 'center' });
      const linksLine = [profile.linkedin_url, profile.github_url, profile.portfolio_url]
        .filter(Boolean)
        .map((u) => String(u).replace(/^https?:\/\/(www\.)?/, ''))
        .join('  |  ');
      if (linksLine) {
        doc.font(primaryFont).fontSize(9).fillColor('#475569').text(linksLine, { align: 'center' });
      }
      doc.moveDown(0.4);

      // Divider line
      doc
        .strokeColor('#cbd5e1')
        .lineWidth(0.8)
        .moveTo(40, doc.y)
        .lineTo(572, doc.y)
        .stroke();
      doc.moveDown(0.5);

      // --- SUMMARY ---
      if (resume.summary) {
        doc.font(boldFont).fontSize(11).fillColor(accentColor).text('PROFESSIONAL SUMMARY');
        doc.moveDown(0.2);
        doc.font(primaryFont).fontSize(9.5).fillColor('#1e293b').text(resume.summary, {
          lineGap: 2,
          align: 'justify',
        });
        doc.moveDown(0.6);
      }

      // --- TECHNICAL SKILLS ---
      if (resume.skills && resume.skills.length > 0) {
        doc.font(boldFont).fontSize(11).fillColor(accentColor).text('TECHNICAL SKILLS');
        doc.moveDown(0.2);

        for (const skillCat of resume.skills) {
          doc
            .font(boldFont)
            .fontSize(9)
            .fillColor('#0f172a')
            .text(`${skillCat.category}: `, { continued: true });
          doc
            .font(primaryFont)
            .fontSize(9)
            .fillColor('#334155')
            .text(skillCat.items.join(', '));
          doc.moveDown(0.15);
        }
        doc.moveDown(0.5);
      }

      // --- WORK EXPERIENCE ---
      if (resume.experience && resume.experience.length > 0) {
        doc.font(boldFont).fontSize(11).fillColor(accentColor).text('PROFESSIONAL EXPERIENCE');
        doc.moveDown(0.3);

        for (const exp of resume.experience) {
          doc.font(boldFont).fontSize(10).fillColor('#0f172a').text(exp.role, { continued: true });
          doc
            .font(primaryFont)
            .fontSize(9.5)
            .fillColor('#64748b')
            .text(`  |  ${exp.company}`, { continued: true });
          doc
            .font(primaryFont)
            .fontSize(9)
            .fillColor('#64748b')
            .text(` (${exp.period})`, { align: 'right' });

          doc.moveDown(0.15);

          for (const bullet of exp.bullets) {
            doc
              .font(primaryFont)
              .fontSize(9)
              .fillColor('#334155')
              .text(`*  ${bullet}`, { indent: 10, lineGap: 1.5 });
          }

          if (exp.technologies && exp.technologies.length > 0) {
            doc
              .font(boldFont)
              .fontSize(8.5)
              .fillColor('#475569')
              .text(`Technologies: `, { indent: 10, continued: true });
            doc
              .font(primaryFont)
              .fontSize(8.5)
              .fillColor('#64748b')
              .text(exp.technologies.join(', '));
          }

          doc.moveDown(0.4);
        }
      }

      // --- KEY PROJECTS ---
      if (resume.projects && resume.projects.length > 0) {
        doc.font(boldFont).fontSize(11).fillColor(accentColor).text('KEY PROJECTS');
        doc.moveDown(0.3);

        for (const proj of resume.projects) {
          doc.font(boldFont).fontSize(9.5).fillColor('#0f172a').text(proj.title);
          doc.moveDown(0.1);
          doc.font(primaryFont).fontSize(9).fillColor('#334155').text(proj.description, { indent: 10 });

          for (const bullet of proj.bullets) {
            doc
              .font(primaryFont)
              .fontSize(9)
              .fillColor('#334155')
              .text(`*  ${bullet}`, { indent: 10, lineGap: 1.5 });
          }

          if (proj.technologies && proj.technologies.length > 0) {
            doc
              .font(boldFont)
              .fontSize(8.5)
              .fillColor('#475569')
              .text(`Technologies: `, { indent: 10, continued: true });
            doc
              .font(primaryFont)
              .fontSize(8.5)
              .fillColor('#64748b')
              .text(proj.technologies.join(', '));
          }

          doc.moveDown(0.3);
        }
      }

      // --- EDUCATION ---
      if (resume.education && resume.education.length > 0) {
        doc.font(boldFont).fontSize(11).fillColor(accentColor).text('EDUCATION');
        doc.moveDown(0.2);

        for (const edu of resume.education) {
          doc
            .font(boldFont)
            .fontSize(9.5)
            .fillColor('#0f172a')
            .text(`${edu.degree} - ${edu.institution}`, { continued: true });
          doc.font(primaryFont).fontSize(9).fillColor('#64748b').text(` (${edu.year})`, { align: 'right' });
          if (edu.details) {
            doc.font(primaryFont).fontSize(8.5).fillColor('#475569').text(edu.details, { indent: 10 });
          }
        }
        doc.moveDown(0.3);
      }

      // --- CERTIFICATIONS ---
      if (resume.certifications && resume.certifications.length > 0) {
        doc.font(boldFont).fontSize(11).fillColor(accentColor).text('CERTIFICATIONS');
        doc.moveDown(0.2);
        for (const cert of resume.certifications) {
          doc.font(primaryFont).fontSize(9).fillColor('#334155').text(`*  ${cert}`, { indent: 10 });
        }
      }

      doc.end();
    });
  }
}

/** Plain one-page cover letter PDF for forms that require a cover letter file. */
export async function generateCoverLetterPDF(profile: CandidateProfile, text: string, outputPath: string): Promise<string> {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'LETTER',
      margins: { top: 60, bottom: 60, left: 64, right: 64 },
      info: { Title: `${profile.full_name} - Cover Letter`, Author: profile.full_name },
    });
    const stream = doc.pipe(createWriteStream(outputPath));
    stream.on('finish', () => resolve(outputPath));
    stream.on('error', reject);
    doc.font('Helvetica-Bold').fontSize(14).fillColor('#0f172a').text(profile.full_name);
    doc
      .font('Helvetica')
      .fontSize(9.5)
      .fillColor('#475569')
      .text([profile.email, profile.phone, profile.location].filter(Boolean).join('  |  '));
    doc.moveDown(1.2);
    doc.font('Helvetica').fontSize(10.5).fillColor('#1e293b').text(text, { lineGap: 3 });
    doc.end();
  });
}

export const pdfGenerator = new PDFGenerator();

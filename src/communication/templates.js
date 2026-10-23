/**
 * Reusable, secure email templates for Orbit recruitment communications.
 * Follows Orbit brand aesthetics and ensures strict HTML escaping.
 */

export function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function baseLayout({ title, bodyHtml, candidateName, isOperational = false }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
</head>
<body style="margin: 0; padding: 0; background-color: #f8fafc; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #0f172a; line-height: 1.6;">
  <div style="max-width: 560px; margin: 32px auto; background-color: #ffffff; border: 1px solid #e2e8f0; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.05);">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#0f172a" style="border-collapse: collapse; background-color: #0f172a;">
      <tr>
        <td bgcolor="#0f172a" style="background-color: #0f172a; padding: 24px 32px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">
          <span style="font-size: 20px; font-weight: 700; color: #ffffff; letter-spacing: -0.5px;">Orbit</span>
          <span style="font-size: 14px; color: #cbd5e1; margin-left: 8px;">&middot; Mechlin Recruitment</span>
        </td>
      </tr>
    </table>
    <div style="padding: 32px;">
      <h1 style="font-size: 20px; font-weight: 700; color: #0f172a; margin-top: 0; margin-bottom: 20px;">${escapeHtml(title)}</h1>
      ${bodyHtml}
      <div style="margin-top: 32px; padding-top: 20px; border-top: 1px solid #e2e8f0; font-size: 14px; color: #475569;">
        Warm regards,<br>
        <strong>The Mechlin Talent Team</strong>
      </div>
    </div>
    <div style="background-color: #f1f5f9; padding: 16px 32px; font-size: 12px; color: #64748b; border-top: 1px solid #e2e8f0;">
      <p style="margin: 0 0 6px 0;">This email was sent to ${escapeHtml(candidateName || 'you')} regarding your application with Mechlin.</p>
      <p style="margin: 0;">${isOperational ? 'This is an operational message regarding your active recruitment process.' : 'You are receiving this communication regarding recruitment opportunities at Mechlin.'}</p>
    </div>
  </div>
</body>
</html>`;
}

function interviewSchedule(vars = {}) {
  const requestedTimezone = vars.timezone ? String(vars.timezone) : 'Asia/Kolkata';
  let timezone = requestedTimezone;
  if (timezone === 'UTC') {
    timezone = 'Asia/Kolkata';
  }
  let scheduledAt = 'To be confirmed';
  if (vars.scheduled_at) {
    const date = new Date(vars.scheduled_at);
    if (Number.isFinite(date.getTime())) {
      try {
        scheduledAt = new Intl.DateTimeFormat('en-US', {
          timeZone: timezone,
          weekday: 'long',
          year: 'numeric',
          month: 'long',
          day: 'numeric',
          hour: 'numeric',
          minute: '2-digit'
        }).format(date);
      } catch {
        timezone = 'Asia/Kolkata';
        scheduledAt = new Intl.DateTimeFormat('en-US', {
          timeZone: timezone,
          weekday: 'long',
          year: 'numeric',
          month: 'long',
          day: 'numeric',
          hour: 'numeric',
          minute: '2-digit'
        }).format(date);
      }
    }
  }
  const parsedDuration = Number(vars.duration_minutes);
  const displayTz = (timezone === 'Asia/Kolkata' || timezone === 'Asia/Calcutta' || timezone === 'IST') ? 'IST' : timezone;
  return {
    scheduledAt: `${scheduledAt} (${displayTz})`,
    duration: Number.isFinite(parsedDuration) && parsedDuration > 0 ? parsedDuration : 45,
    timezone: displayTz
  };
}

function interviewMeetingHtml(vars = {}) {
  if (vars.meeting_url) {
    return `
      <div style="margin: 20px 0; text-align: center;">
        <a href="${escapeHtml(vars.meeting_url)}" style="background-color: #4f46e5; color: #ffffff; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: 600; display: inline-block;">Join Microsoft Teams Meeting</a>
      </div>
      <p style="font-size: 13px; color: #475569; word-break: break-all;">Meeting Link: <a href="${escapeHtml(vars.meeting_url)}">${escapeHtml(vars.meeting_url)}</a></p>
    `;
  }
  return `
    <div style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 14px 16px; margin: 18px 0;">
      <p style="margin: 0; font-size: 14px; color: #334155;"><strong>Joining instructions:</strong> Your recruiter will send the Microsoft Teams meeting link before your interview. If you have not received it 24 hours before the scheduled time, please reply to this email and we will resend it.</p>
    </div>
  `;
}

function interviewMeetingText(vars = {}) {
  return vars.meeting_url
    ? `Microsoft Teams Meeting Link:\n${vars.meeting_url}`
    : 'Joining instructions: Your recruiter will send the Microsoft Teams meeting link before your interview. If you have not received it 24 hours before the scheduled time, please reply to this email and we will resend it.';
}

export const TEMPLATES = {
  application_acknowledgement: {
    id: 'application_acknowledgement',
    name: 'Application Acknowledgement',
    category: 'recruitment',
    isEssential: false,
    render(vars) {
      const candidateName = vars.candidate_name || 'Candidate';
      const reqTitle = vars.requisition_title || 'Open Position';
      const team = vars.team ? ` on the ${vars.team} team` : '';
      const notes = vars.notes ? `
        <div style="background-color: #f8fafc; border-left: 3px solid #4f46e5; border-radius: 4px; padding: 14px 16px; margin: 18px 0;">
          <p style="margin: 0; font-size: 14px; color: #334155;"><strong>Additional Details:</strong><br>${escapeHtml(vars.notes)}</p>
        </div>
      ` : '';
      const title = `Application received: ${reqTitle}`;
      const subject = `Application received: ${reqTitle} at Mechlin Orbit`;

      const html = baseLayout({
        title,
        candidateName,
        isOperational: false,
        bodyHtml: `
          <p style="font-size: 15px; margin-bottom: 16px;">Dear ${escapeHtml(candidateName)},</p>
          <p style="font-size: 15px; margin-bottom: 16px;">Thank you for your interest in joining Mechlin! We have received your application for the <strong>${escapeHtml(reqTitle)}</strong> position${escapeHtml(team)}.</p>
          <p style="font-size: 15px; margin-bottom: 16px;">Our talent acquisition team and hiring managers are reviewing your background and qualifications. If your skills and experience align with what we are seeking for this role, a member of our team will reach out to discuss next steps.</p>
          ${notes}
          <p style="font-size: 15px; margin-bottom: 0;">We appreciate the time you took to share your qualifications with us.</p>
        `
      });

      const text = `Dear ${candidateName},

Thank you for your interest in joining Mechlin! We have received your application for the ${reqTitle} position${team}.

Our talent acquisition team and hiring managers are reviewing your background and qualifications. If your skills and experience align with what we are seeking for this role, a member of our team will reach out to discuss next steps.
${vars.notes ? `\nAdditional Details:\n${vars.notes}\n` : ''}
We appreciate the time you took to share your qualifications with us.

Warm regards,
The Mechlin Talent Team`;

      return { subject, html, text };
    }
  },

  interview_invitation: {
    id: 'interview_invitation',
    name: 'Interview Invitation',
    category: 'interview',
    isEssential: true,
    render(vars) {
      const candidateName = vars.candidate_name || 'Candidate';
      const reqTitle = vars.requisition_title || 'Position';
      const schedule = interviewSchedule(vars);
      const scheduledAt = schedule.scheduledAt;
      const interviewer = vars.interviewer_name || 'Our hiring team';
      const notes = vars.notes ? `<p style="font-size: 14px; background: #f8fafc; border-left: 3px solid #0f172a; padding: 12px; margin: 16px 0;"><strong>Details & Preparation:</strong><br>${escapeHtml(vars.notes)}</p>` : '';
      const meetingButton = interviewMeetingHtml(vars);
      const title = `Interview Invitation: ${reqTitle}`;
      const subject = `Interview invitation: ${reqTitle} at Mechlin Orbit`;

      const html = baseLayout({
        title,
        candidateName,
        isOperational: true,
        bodyHtml: `
          <p style="font-size: 15px; margin-bottom: 16px;">Dear ${escapeHtml(candidateName)},</p>
          <p style="font-size: 15px; margin-bottom: 16px;">We were impressed by your profile and would like to invite you to interview for the <strong>${escapeHtml(reqTitle)}</strong> position at Mechlin.</p>
          <div style="background-color: #f1f5f9; border-radius: 8px; padding: 16px; margin: 20px 0;">
            <p style="margin: 0 0 8px 0; font-size: 14px;"><strong>Date & Time:</strong> ${escapeHtml(scheduledAt)}</p>
            <p style="margin: 0 0 8px 0; font-size: 14px;"><strong>Duration:</strong> ${schedule.duration} minutes</p>
            <p style="margin: 0 0 8px 0; font-size: 14px;"><strong>Timezone:</strong> ${escapeHtml(schedule.timezone)}</p>
            <p style="margin: 0; font-size: 14px;"><strong>Interviewer:</strong> ${escapeHtml(interviewer)}</p>
          </div>
          ${meetingButton}
          ${notes}
          <p style="font-size: 15px; margin-bottom: 16px;">If this time does not work for your schedule or if you require any accessibility accommodations, please let us know as soon as possible.</p>
          <p style="font-size: 15px; margin-bottom: 0;">We look forward to speaking with you!</p>
        `
      });

      const text = `Dear ${candidateName},

We were impressed by your profile and would like to invite you to interview for the ${reqTitle} position at Mechlin.

Interview Details:
- Date & Time: ${scheduledAt}
- Duration: ${schedule.duration} minutes
- Timezone: ${schedule.timezone}
- Interviewer: ${interviewer}
${interviewMeetingText(vars)}${vars.notes ? `\n\nDetails & Preparation:\n${vars.notes}` : ''}

If this time does not work for your schedule or if you require any accessibility accommodations, please let us know as soon as possible.

We look forward to speaking with you!

Warm regards,
The Mechlin Talent Team`;

      return { subject, html, text };
    }
  },

  interview_update: {
    id: 'interview_update',
    name: 'Interview Update / Rescheduled',
    category: 'interview',
    isEssential: true,
    render(vars) {
      const candidateName = vars.candidate_name || 'Candidate';
      const reqTitle = vars.requisition_title || 'Position';
      const schedule = interviewSchedule(vars);
      const scheduledAt = schedule.scheduledAt;
      const interviewer = vars.interviewer_name || 'Our hiring team';
      const reason = vars.notes ? `<p style="font-size: 14px; background: #f8fafc; border-left: 3px solid #0f172a; padding: 12px; margin: 16px 0;"><strong>Update Note:</strong><br>${escapeHtml(vars.notes)}</p>` : '';
      const meetingButton = interviewMeetingHtml(vars);
      const title = `Interview Updated: ${reqTitle}`;
      const subject = `Interview update: ${reqTitle} at Mechlin Orbit`;

      const html = baseLayout({
        title,
        candidateName,
        isOperational: true,
        bodyHtml: `
          <p style="font-size: 15px; margin-bottom: 16px;">Dear ${escapeHtml(candidateName)},</p>
          <p style="font-size: 15px; margin-bottom: 16px;">Your interview schedule for the <strong>${escapeHtml(reqTitle)}</strong> position has been updated.</p>
          <div style="background-color: #f1f5f9; border-radius: 8px; padding: 16px; margin: 20px 0;">
            <p style="margin: 0 0 8px 0; font-size: 14px;"><strong>Updated Date & Time:</strong> ${escapeHtml(scheduledAt)}</p>
            <p style="margin: 0 0 8px 0; font-size: 14px;"><strong>Duration:</strong> ${schedule.duration} minutes</p>
            <p style="margin: 0 0 8px 0; font-size: 14px;"><strong>Timezone:</strong> ${escapeHtml(schedule.timezone)}</p>
            <p style="margin: 0; font-size: 14px;"><strong>Interviewer:</strong> ${escapeHtml(interviewer)}</p>
          </div>
          ${meetingButton}
          ${reason}
          <p style="font-size: 15px; margin-bottom: 0;">Please reach out if you have any questions or if you need to adjust this schedule.</p>
        `
      });

      const text = `Dear ${candidateName},

Your interview schedule for the ${reqTitle} position has been updated.

Updated Details:
- Date & Time: ${scheduledAt}
- Duration: ${schedule.duration} minutes
- Timezone: ${schedule.timezone}
- Interviewer: ${interviewer}
${interviewMeetingText(vars)}${vars.notes ? `\n\nUpdate Note:\n${vars.notes}` : ''}

Please reach out if you have any questions or if you need to adjust this schedule.

Warm regards,
The Mechlin Talent Team`;

      return { subject, html, text };
    }
  },

  interview_cancellation: {
    id: 'interview_cancellation',
    name: 'Interview Cancellation',
    category: 'interview',
    isEssential: true,
    render(vars) {
      const candidateName = vars.candidate_name || 'Candidate';
      const reqTitle = vars.requisition_title || 'Position';
      let scheduledAt = '';
      if (vars.scheduled_at) {
        const date = new Date(vars.scheduled_at);
        if (Number.isFinite(date.getTime())) {
          let tz = vars.timezone || 'Asia/Kolkata';
          if (tz === 'UTC') tz = 'Asia/Kolkata';
          const displayTz = (tz === 'Asia/Kolkata' || tz === 'Asia/Calcutta' || tz === 'IST') ? 'IST' : tz;
          try {
            scheduledAt = `${new Intl.DateTimeFormat('en-US', {
              timeZone: tz === 'IST' ? 'Asia/Kolkata' : tz,
              weekday: 'short',
              year: 'numeric',
              month: 'short',
              day: 'numeric',
              hour: 'numeric',
              minute: '2-digit'
            }).format(date)} (${displayTz})`;
          } catch {
            scheduledAt = `${date.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' })} (IST)`;
          }
        }
      }
      const reason = vars.notes ? `<p style="font-size: 14px; background: #f8fafc; border-left: 3px solid #0f172a; padding: 12px; margin: 16px 0;"><strong>Reason / Notes:</strong><br>${escapeHtml(vars.notes)}</p>` : '';
      const title = `Interview Cancelled: ${reqTitle}`;
      const subject = `Interview cancelled: ${reqTitle} at Mechlin Orbit`;

      const html = baseLayout({
        title,
        candidateName,
        isOperational: true,
        bodyHtml: `
          <p style="font-size: 15px; margin-bottom: 16px;">Dear ${escapeHtml(candidateName)},</p>
          <p style="font-size: 15px; margin-bottom: 16px;">Please note that your interview for the <strong>${escapeHtml(reqTitle)}</strong> position${scheduledAt ? ` previously scheduled for <strong>${escapeHtml(scheduledAt)}</strong>` : ''} has been cancelled.</p>
          ${reason}
          <p style="font-size: 15px; margin-bottom: 0;">Our recruiting team will reach out with any updates regarding next steps or rescheduling.</p>
        `
      });

      const text = `Dear ${candidateName},

Please note that your interview for the ${reqTitle} position${scheduledAt ? ` previously scheduled for ${scheduledAt}` : ''} has been cancelled.
${vars.notes ? `\nReason / Notes:\n${vars.notes}\n` : ''}
Our recruiting team will reach out with any updates regarding next steps or rescheduling.

Warm regards,
The Mechlin Talent Team`;

      return { subject, html, text };
    }
  },

  application_rejection: {
    id: 'application_rejection',
    name: 'Status Update / Not Selected',
    category: 'recruitment',
    isEssential: false,
    render(vars) {
      const candidateName = vars.candidate_name || 'Candidate';
      const reqTitle = vars.requisition_title || 'Position';
      const notes = vars.notes ? `
        <div style="background-color: #f8fafc; border-left: 3px solid #64748b; border-radius: 4px; padding: 14px 16px; margin: 18px 0;">
          <p style="margin: 0; font-size: 14px; color: #334155;"><strong>Feedback / Additional Notes:</strong><br>${escapeHtml(vars.notes)}</p>
        </div>
      ` : '';
      const title = `Update on your application: ${reqTitle}`;
      const subject = `Update regarding your application for ${reqTitle}`;

      const html = baseLayout({
        title,
        candidateName,
        isOperational: false,
        bodyHtml: `
          <p style="font-size: 15px; margin-bottom: 16px;">Dear ${escapeHtml(candidateName)},</p>
          <p style="font-size: 15px; margin-bottom: 16px;">Thank you for your interest in Mechlin and for the time and energy you invested in applying for the <strong>${escapeHtml(reqTitle)}</strong> position.</p>
          <p style="font-size: 15px; margin-bottom: 16px;">We received a strong response from many qualified candidates, and after thoughtful consideration, we have decided to move forward with other applicants whose experience more closely matches our immediate needs for this specific role.</p>
          ${notes}
          <p style="font-size: 15px; margin-bottom: 16px;">We were impressed by your skills and would love to stay connected for future opportunities that may be a strong fit for your career goals.</p>
          <p style="font-size: 15px; margin-bottom: 0;">We wish you every success in your ongoing job search and professional journey.</p>
        `
      });

      const text = `Dear ${candidateName},

Thank you for your interest in Mechlin and for the time and energy you invested in applying for the ${reqTitle} position.

We received a strong response from many qualified candidates, and after thoughtful consideration, we have decided to move forward with other applicants whose experience more closely matches our immediate needs for this specific role.
${vars.notes ? `\nFeedback / Additional Notes:\n${vars.notes}\n` : ''}
We were impressed by your skills and would love to stay connected for future opportunities that may be a strong fit for your career goals.

We wish you every success in your ongoing job search and professional journey.

Warm regards,
The Mechlin Talent Team`;

      return { subject, html, text };
    }
  },

  offer_letter: {
    id: 'offer_letter',
    name: 'Offer Letter / Communication',
    category: 'offer',
    isEssential: true,
    render(vars) {
      const candidateName = vars.candidate_name || 'Candidate';
      const reqTitle = vars.requisition_title || 'Position';
      const docTitle = vars.document_title || vars.requisition_title || 'Employment Agreement';
      const team = vars.team ? ` with the ${vars.team} team` : '';
      const signingUrl = vars.signing_url || '';
      const expiresAt = vars.expires_at || '';
      const validity = vars.validity || '';
      const isCompleted = Boolean(vars.is_completed);

      const notes = vars.notes ? `<div style="background-color: #f1f5f9; border-radius: 8px; padding: 14px 16px; margin: 16px 0;"><p style="margin: 0; font-size: 14px; color: #334155;">${escapeHtml(vars.notes)}</p></div>` : '';

      let title = `Offer of Employment: ${reqTitle}`;
      let subject = `Offer of Employment: ${reqTitle} at Mechlin Orbit`;
      let bodyHtml = '';
      let bodyText = '';

      if (isCompleted) {
        title = `Executed Agreement: ${docTitle}`;
        subject = `Executed: ${docTitle} - Electronic Signature Completed`;
        bodyHtml = `
          <p style="font-size: 15px; margin-bottom: 16px;">Dear ${escapeHtml(candidateName)},</p>
          <div style="background-color: #e6f5ee; border: 1px solid #89dfb5; border-radius: 8px; padding: 16px; margin: 16px 0;">
            <p style="margin: 0 0 6px 0; font-weight: 600; color: #226546; font-size: 15px;">✓ Electronic Signature Executed & Legally Verified</p>
            <p style="margin: 0; font-size: 13px; color: #1e3a2b;">Your electronic signature for <strong>${escapeHtml(docTitle)}</strong> has been recorded and verified alongside the tamper-evident Certificate of Completion.</p>
          </div>
          ${signingUrl ? `
            <div style="margin: 22px 0; text-align: center;">
              <a href="${escapeHtml(signingUrl)}" style="background-color: #226546; color: #ffffff; padding: 12px 26px; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 14px; display: inline-block;">Download Executed Document (PDF)</a>
            </div>
            <p style="font-size: 12px; color: #64748b; word-break: break-all;">Direct link: <a href="${escapeHtml(signingUrl)}" style="color: #226546;">${escapeHtml(signingUrl)}</a></p>
          ` : ''}
          <p style="font-size: 14px; color: #475569; margin-top: 16px;">Thank you for completing this agreement. Our recruitment and onboarding team will be in touch with next steps.</p>
        `;
        bodyText = `Dear ${candidateName},\n\nYour electronic signature for "${docTitle}" has been recorded and legally executed alongside the tamper-evident Certificate of Completion.\n\n${signingUrl ? `Download your executed PDF document:\n${signingUrl}\n\n` : ''}Thank you for completing this agreement.`;
      } else if (signingUrl) {
        title = `Electronic Signature Request: ${docTitle}`;
        subject = `Action Required: Electronic Signature Request - ${docTitle} at Mechlin Orbit`;
        bodyHtml = `
          <p style="font-size: 15px; margin-bottom: 16px;">Dear ${escapeHtml(candidateName)},</p>
          <p style="font-size: 15px; margin-bottom: 16px;">On behalf of Mechlin, we are pleased to present you with your offer agreement for the <strong>${escapeHtml(reqTitle)}</strong> position${escapeHtml(team)}.</p>
          <p style="font-size: 15px; margin-bottom: 16px;">Please review the agreement and electronically execute your acceptance using our secure digital signature portal:</p>
          <div style="margin: 24px 0; text-align: center;">
            <a href="${escapeHtml(signingUrl)}" style="background-color: #086b97; color: #ffffff; padding: 14px 28px; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 15px; display: inline-block; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">Review & Sign Document</a>
          </div>
          <div style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 14px 16px; margin: 18px 0; font-size: 13px; color: #475569;">
            <p style="margin: 0 0 6px 0;"><strong>Document:</strong> ${escapeHtml(docTitle)}</p>
            ${expiresAt ? `<p style="margin: 0 0 6px 0;"><strong>Link Validity:</strong> Valid until ${escapeHtml(expiresAt)}${validity ? ` (${escapeHtml(validity)})` : ''}</p>` : ''}
            <p style="margin: 0;"><strong>Security & Compliance:</strong> Executed under the U.S. Electronic Signatures in Global and National Commerce Act (ESIGN) and Uniform Electronic Transactions Act (UETA). Please execute before the link expires.</p>
          </div>
          ${notes}
          <p style="font-size: 12px; color: #64748b; word-break: break-all; margin-top: 14px;">If the button above does not work, copy and paste this secure URL into your browser:<br><a href="${escapeHtml(signingUrl)}" style="color: #086b97;">${escapeHtml(signingUrl)}</a></p>
        `;
        bodyText = `Dear ${candidateName},\n\nOn behalf of Mechlin, we are pleased to present you with your offer agreement for the ${reqTitle} position${team}.\n\nPlease review and electronically execute your acceptance online:\n${signingUrl}\n\n${expiresAt ? `Link Validity: Valid until ${expiresAt}${validity ? ` (${validity})` : ''}\n` : ''}${vars.notes ? `\n${vars.notes}\n` : ''}\nWarm regards,\nThe Mechlin Talent Team`;
      } else {
        bodyHtml = `
          <p style="font-size: 15px; margin-bottom: 16px;">Dear ${escapeHtml(candidateName)},</p>
          <p style="font-size: 15px; margin-bottom: 16px;">On behalf of Mechlin, we are thrilled to offer you the position of <strong>${escapeHtml(reqTitle)}</strong>${escapeHtml(team)}!</p>
          <p style="font-size: 15px; margin-bottom: 16px;">Throughout our interviews, our team was consistently impressed by your skills, perspectives, and potential to make an impact on our mission.</p>
          ${notes}
          <p style="font-size: 15px; margin-bottom: 16px;">Your dedicated recruiter will follow up with formal paperwork, benefits information, and next steps for onboarding.</p>
          <p style="font-size: 15px; margin-bottom: 0;">Congratulations, and welcome to the team!</p>
        `;
        bodyText = `Dear ${candidateName},\n\nOn behalf of Mechlin, we are thrilled to offer you the position of ${reqTitle}${team}!\n\nThroughout our interviews, our team was consistently impressed by your skills, perspectives, and potential to make an impact on our mission.\n${vars.notes ? `\n${vars.notes}\n` : ''}\nYour dedicated recruiter will follow up with formal paperwork, benefits information, and next steps for onboarding.\n\nCongratulations, and welcome to the team!\n\nWarm regards,\nThe Mechlin Talent Team`;
      }

      const html = baseLayout({
        title,
        candidateName,
        isOperational: true,
        bodyHtml
      });

      return { subject, html, text: bodyText };
    }
  }
};

export const EXTRA_TEMPLATES = {
  stage_update: {
    id: 'stage_update',
    name: 'Pipeline Stage Update',
    category: 'recruitment',
    isEssential: true,
    render(vars) {
      const candidateName = vars.candidate_name || 'Candidate';
      const reqTitle = vars.requisition_title || 'Position';
      const stage = vars.stage || vars.new_stage || 'Updated Stage';
      const previousStage = vars.previous_stage || vars.from_stage || '';
      const team = vars.team ? ` with the ${vars.team} team` : '';
      const notes = vars.notes ? `<div style="background-color: #f1f5f9; border-radius: 8px; padding: 14px 16px; margin: 16px 0;"><p style="margin: 0; font-size: 14px; color: #334155;"><strong>Note from Hiring Team:</strong><br>${escapeHtml(vars.notes)}</p></div>` : '';

      let stageMessage = 'Your application is progressing through our evaluation process. Thank you for your continued interest in Mechlin Orbit.';
      if (stage === 'Screening') {
        stageMessage = 'Our recruiting team is currently reviewing your profile and credentials. We will reach out if there is strong alignment for an initial discussion.';
      } else if (stage === 'Interview') {
        stageMessage = 'Congratulations on advancing to the interview stage! Our recruiting team will follow up shortly to coordinate interview scheduling.';
      } else if (stage === 'Offer') {
        stageMessage = 'We are pleased to inform you that your application has advanced to the offer stage. Our talent team will be in touch with details regarding your formal employment offer.';
      } else if (stage === 'Hired') {
        stageMessage = 'Congratulations on successfully completing our hiring process and joining Mechlin! Welcome to the team!';
      } else if (stage === 'Applied') {
        stageMessage = 'Your application has been received and logged into our candidate pipeline. Our recruiting team will review your qualifications.';
      }

      const title = `Application Status Update: ${stage}`;
      const subject = `Update on your application for ${reqTitle}: ${stage}`;

      const html = baseLayout({
        title,
        candidateName,
        isOperational: true,
        bodyHtml: `
          <p style="font-size: 15px; margin-bottom: 16px;">Dear ${escapeHtml(candidateName)},</p>
          <p style="font-size: 15px; margin-bottom: 16px;">We would like to share an update regarding your application for the <strong>${escapeHtml(reqTitle)}</strong> position${escapeHtml(team)}.</p>
          <div style="background-color: #f1f5f9; border-radius: 8px; padding: 16px; margin: 20px 0;">
            <p style="margin: 0 0 6px 0; font-size: 14px;"><strong>Position:</strong> ${escapeHtml(reqTitle)}</p>
            <p style="margin: 0 0 6px 0; font-size: 14px;"><strong>Updated Pipeline Stage:</strong> <span style="background-color: #e0e7ff; color: #3730a3; padding: 2px 8px; border-radius: 4px; font-weight: 600;">${escapeHtml(stage)}</span></p>
            ${previousStage ? `<p style="margin: 0; font-size: 13px; color: #64748b;">Previous Stage: ${escapeHtml(previousStage)}</p>` : ''}
          </div>
          <p style="font-size: 15px; margin-bottom: 16px;">${stageMessage}</p>
          ${notes}
          <p style="font-size: 15px; margin-bottom: 0;">Our talent acquisition team will keep you informed as we proceed through the process.</p>
        `
      });

      const text = `Dear ${candidateName},\n\nWe would like to share an update regarding your application for the ${reqTitle} position${team}.\n\nUpdated Pipeline Stage: ${stage}${previousStage ? ` (Previous: ${previousStage})` : ''}\n\n${stageMessage}\n${vars.notes ? `\nNote from Hiring Team:\n${vars.notes}\n` : ''}\nOur talent acquisition team will keep you informed as we proceed through the process.\n\nWarm regards,\nThe Mechlin Talent Team`;

      return { subject, html, text };
    }
  },
  get rejection() {
    return TEMPLATES.application_rejection;
  },
  get status_update() {
    return EXTRA_TEMPLATES.stage_update;
  }
};

export function getAvailableTemplates() {
  return Object.values(TEMPLATES).map(t => ({
    id: t.id,
    name: t.name,
    category: t.category,
    isEssential: t.isEssential
  }));
}

export function renderTemplate(templateId, variables = {}) {
  const tpl = TEMPLATES[templateId] || EXTRA_TEMPLATES[templateId];
  if (!tpl) {
    throw new Error(`Unknown email template: "${templateId}"`);
  }
  return {
    ...tpl.render(variables),
    isEssential: tpl.isEssential,
    templateId
  };
}

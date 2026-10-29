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

export function resolveAppOrigin(vars = {}) {
  const raw = vars.app_origin || vars.appOrigin || (typeof process !== 'undefined' && (process.env.APP_ORIGIN || process.env.ORIGIN)) || 'http://localhost:3000';
  return String(raw).replace(/\/+$/, '');
}

function baseLayout({ title, bodyHtml, candidateName, isOperational = false, appOrigin = null }) {
  const origin = resolveAppOrigin({ appOrigin });
  const orbitLogoUrl = `${origin}/icon-192.png`;
  const mechlinLogoUrl = `${origin}/mechlin-logo.webp`;

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
        <td bgcolor="#0f172a" style="background-color: #0f172a; padding: 20px 32px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse: collapse;">
            <tr>
              <td style="vertical-align: middle; padding: 0 16px 0 0;">
                <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse: collapse;">
                  <tr>
                    <td style="vertical-align: middle;">
                      <img src="${orbitLogoUrl}" alt="Orbit" width="30" height="30" style="display: block; width: 30px; height: 30px; border-radius: 6px; border: 0;" />
                    </td>
                    <td style="vertical-align: middle; padding-left: 10px;">
                      <span style="font-size: 19px; font-weight: 700; color: #ffffff; letter-spacing: -0.5px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; line-height: 1;">Orbit</span>
                    </td>
                  </tr>
                </table>
              </td>
              <td style="vertical-align: middle; padding: 0 16px; border-left: 1px solid rgba(255, 255, 255, 0.35); height: 26px;">
                &nbsp;
              </td>
              <td style="vertical-align: middle; padding: 0 0 0 2px;">
                <table role="presentation" cellpadding="0" cellspacing="0" border="0" bgcolor="#ffffff" style="border-collapse: collapse; background-color: #ffffff; border-radius: 6px;">
                  <tr>
                    <td bgcolor="#ffffff" style="background-color: #ffffff; padding: 4px 10px; border-radius: 6px; vertical-align: middle;">
                      <img src="${mechlinLogoUrl}" alt="Mechlin Technologies" width="118" height="22" style="display: block; max-height: 30px; width: auto; border: 0;" />
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
          </table>
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

export function getMeetingDetails(url) {
  if (!url) {
    return {
      name: 'Meeting',
      buttonText: 'Join Meeting',
      labelText: 'Meeting Link'
    };
  }
  const u = String(url).toLowerCase();
  if (u.includes('teams.microsoft.com') || u.includes('teams.live.com')) {
    return {
      name: 'Microsoft Teams',
      buttonText: 'Join Microsoft Teams Meeting',
      labelText: 'Microsoft Teams Meeting Link'
    };
  }
  if (u.includes('meet.google.com')) {
    return {
      name: 'Google Meet',
      buttonText: 'Join Google Meet',
      labelText: 'Google Meet Link'
    };
  }
  if (u.includes('zoom.us') || u.includes('zoom.com')) {
    return {
      name: 'Zoom',
      buttonText: 'Join Zoom Meeting',
      labelText: 'Zoom Meeting Link'
    };
  }
  if (u.includes('webex.com')) {
    return {
      name: 'Webex',
      buttonText: 'Join Webex Meeting',
      labelText: 'Webex Meeting Link'
    };
  }
  return {
    name: 'Online Video Meeting',
    buttonText: 'Join Meeting',
    labelText: 'Meeting Link'
  };
}

function interviewMeetingHtml(vars = {}) {
  const isPhysical = vars.interview_type === 'in_person' || vars.format === 'in_person' || vars.format === 'physical';
  if (isPhysical) {
    const loc = vars.location || 'Mechlin Technologies Office';
    return `
      <div style="background-color: #f8fafc; border: 1px solid #cbd5e1; border-left: 4px solid #0284c7; border-radius: 8px; padding: 16px; margin: 20px 0;">
        <p style="margin: 0 0 6px 0; font-size: 14px; font-weight: 600; color: #0f172a;">Interview Format: In-Person / Physical Interview</p>
        <p style="margin: 0 0 6px 0; font-size: 14px; color: #334155;"><strong>Location / Venue:</strong> ${escapeHtml(loc)}</p>
        <p style="margin: 0; font-size: 13px; color: #64748b;">Please arrive at the venue 10 minutes prior to your scheduled time with a valid government photo ID for security entry. No online meeting link is required for this on-site evaluation.</p>
      </div>
    `;
  }
  if (vars.meeting_url) {
    const meeting = getMeetingDetails(vars.meeting_url);
    return `
      <div style="margin: 20px 0; text-align: center;">
        <a href="${escapeHtml(vars.meeting_url)}" style="background-color: #4f46e5; color: #ffffff; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: 600; display: inline-block;">${escapeHtml(meeting.buttonText)}</a>
      </div>
      <p style="font-size: 13px; color: #475569; word-break: break-all;">${escapeHtml(meeting.labelText)}: <a href="${escapeHtml(vars.meeting_url)}">${escapeHtml(vars.meeting_url)}</a></p>
    `;
  }
  return `
    <div style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 14px 16px; margin: 18px 0;">
      <p style="margin: 0; font-size: 14px; color: #334155;"><strong>Joining instructions:</strong> Your recruiter will send the meeting link before your interview. If you have not received it 24 hours before the scheduled time, please reply to this email and we will resend it.</p>
    </div>
  `;
}

function interviewMeetingText(vars = {}) {
  const isPhysical = vars.interview_type === 'in_person' || vars.format === 'in_person' || vars.format === 'physical';
  if (isPhysical) {
    const loc = vars.location || 'Mechlin Technologies Office';
    return `Interview Format: In-Person / Physical Interview\nLocation / Venue: ${loc}\nPlease arrive 10 minutes prior with a valid government photo ID. No online meeting link is required for this on-site evaluation.`;
  }
  if (vars.meeting_url) {
    const meeting = getMeetingDetails(vars.meeting_url);
    return `${meeting.labelText}:\n${vars.meeting_url}`;
  }
  return 'Joining instructions: Your recruiter will send the meeting link before your interview. If you have not received it 24 hours before the scheduled time, please reply to this email and we will resend it.';
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
      const isPhysical = vars.interview_type === 'in_person' || vars.format === 'in_person' || vars.format === 'physical';
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
            <p style="margin: 0 0 8px 0; font-size: 14px;"><strong>Interviewer:</strong> ${escapeHtml(interviewer)}</p>
            <p style="margin: 0; font-size: 14px;"><strong>Format:</strong> ${isPhysical ? 'In-Person / Physical' : 'Virtual / Online (Microsoft Teams)'}</p>
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
- Format: ${isPhysical ? 'In-Person / Physical' : 'Virtual / Online (Microsoft Teams)'}
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
      const isPhysical = vars.interview_type === 'in_person' || vars.format === 'in_person' || vars.format === 'physical';
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
            <p style="margin: 0 0 8px 0; font-size: 14px;"><strong>Interviewer:</strong> ${escapeHtml(interviewer)}</p>
            <p style="margin: 0; font-size: 14px;"><strong>Format:</strong> ${isPhysical ? 'In-Person / Physical' : 'Virtual / Online (Microsoft Teams)'}</p>
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
- Format: ${isPhysical ? 'In-Person / Physical' : 'Virtual / Online (Microsoft Teams)'}
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

      const hasInterview = Boolean(vars.scheduled_at || vars.has_interview);
      const schedule = hasInterview ? interviewSchedule(vars) : null;
      const interviewer = vars.interviewer_name || 'Our hiring team';
      const isPhysical = vars.interview_type === 'in_person' || vars.format === 'in_person' || vars.format === 'physical';
      const meetingButton = hasInterview ? interviewMeetingHtml(vars) : '';

      let stageMessage = `Your application has moved to the ${stage} stage in our recruitment process. Our talent acquisition team will keep you informed of subsequent steps.`;
      const normStage = String(stage).trim().toLowerCase();

      if (hasInterview) {
        stageMessage = `Congratulations on advancing to ${stage}! Your interview has been scheduled as detailed below.`;
      } else if (normStage === 'applied') {
        stageMessage = 'Your application has been received and logged into our candidate pipeline. Our recruiting team will review your qualifications and credentials.';
      } else if (normStage === 'screening' || normStage === 'screening round') {
        stageMessage = 'Our recruiting team is currently reviewing your profile and credentials. We will reach out if there is strong alignment for an initial discussion.';
      } else if (normStage === 'interview round 1' || normStage === 'round 1') {
        stageMessage = 'Congratulations on advancing to Interview Round 1! Our recruiting team will follow up shortly to coordinate interview scheduling.';
      } else if (normStage === 'interview round 2' || normStage === 'round 2') {
        stageMessage = 'Congratulations on advancing to Interview Round 2! Our team will follow up with scheduling details for your next technical evaluation.';
      } else if (normStage === 'interview round 3' || normStage === 'round 3') {
        stageMessage = 'Congratulations on advancing to Interview Round 3! Our recruiting team will coordinate your final round interview.';
      } else if (normStage === 'hr round' || normStage === 'hr discussion') {
        stageMessage = 'Congratulations on advancing to the HR Round! Our talent acquisition team will connect with you to discuss organizational alignment and next steps.';
      } else if (normStage === 'interview') {
        stageMessage = 'Congratulations on advancing to the interview stage! Our recruiting team will follow up shortly to coordinate interview scheduling.';
      } else if (normStage === 'offer') {
        stageMessage = 'We are pleased to inform you that your application has advanced to the offer stage. Our talent team will be in touch with details regarding your formal employment offer.';
      } else if (normStage === 'pre-onboarding training' || normStage === 'training') {
        stageMessage = 'Congratulations! Your application has advanced to Pre-Onboarding Training. Our team will share your orientation milestones and curriculum.';
      } else if (normStage === 'onboarding') {
        stageMessage = 'Congratulations on completing your evaluation milestones! Your application has advanced to Onboarding as we prepare for your official start.';
      } else if (normStage === 'hired') {
        stageMessage = 'Congratulations on successfully completing our hiring process and joining Mechlin! Welcome to the team!';
      } else if (normStage === 'rejected') {
        stageMessage = 'Thank you for your interest in Mechlin and for the time invested in our evaluation process. After careful review, we have decided to move forward with other applicants whose experience more closely matches our immediate needs for this specific role.';
      } else if (normStage === 'revoked') {
        stageMessage = 'Please be advised that your formal employment offer for this position has been revoked. If you have questions regarding this decision, please contact your talent acquisition representative.';
      }

      const isRejection = normStage === 'rejected' || normStage === 'revoked';
      const title = isRejection ? `Application Status Update: ${stage}` : `Application Status Update: ${stage}`;
      const subject = isRejection ? `Update regarding your application for ${reqTitle}: ${stage}` : `Update on your application for ${reqTitle}: ${stage}`;
      const appOrigin = resolveAppOrigin(vars);

      const interviewHtml = hasInterview ? `
        <div style="background-color: #f1f5f9; border-radius: 8px; padding: 16px; margin: 20px 0;">
          <p style="margin: 0 0 8px 0; font-size: 14px; font-weight: 600; color: #0f172a;">Interview Details:</p>
          <p style="margin: 0 0 6px 0; font-size: 14px;"><strong>Date & Time:</strong> ${escapeHtml(schedule.scheduledAt)}</p>
          <p style="margin: 0 0 6px 0; font-size: 14px;"><strong>Duration:</strong> ${schedule.duration} minutes</p>
          <p style="margin: 0 0 6px 0; font-size: 14px;"><strong>Timezone:</strong> ${escapeHtml(schedule.timezone)}</p>
          <p style="margin: 0 0 6px 0; font-size: 14px;"><strong>Interviewer:</strong> ${escapeHtml(interviewer)}</p>
          <p style="margin: 0; font-size: 14px;"><strong>Format:</strong> ${isPhysical ? 'In-Person / Physical' : 'Virtual / Online (Microsoft Teams)'}</p>
        </div>
        ${meetingButton}
      ` : '';

      const interviewText = hasInterview ? `\nInterview Details:\n- Date & Time: ${schedule.scheduledAt}\n- Duration: ${schedule.duration} minutes\n- Timezone: ${schedule.timezone}\n- Interviewer: ${interviewer}\n- Format: ${isPhysical ? 'In-Person / Physical' : 'Virtual / Online (Microsoft Teams)'}\n${interviewMeetingText(vars)}\n` : '';

      const html = baseLayout({
        title,
        candidateName,
        isOperational: true,
        appOrigin,
        bodyHtml: `
          <p style="font-size: 15px; margin-bottom: 16px;">Dear ${escapeHtml(candidateName)},</p>
          <p style="font-size: 15px; margin-bottom: 16px;">We would like to share an update regarding your application for the <strong>${escapeHtml(reqTitle)}</strong> position${escapeHtml(team)}.</p>
          <div style="background-color: #f1f5f9; border-radius: 8px; padding: 16px; margin: 20px 0;">
            <p style="margin: 0 0 6px 0; font-size: 14px;"><strong>Position:</strong> ${escapeHtml(reqTitle)}</p>
            <p style="margin: 0 0 6px 0; font-size: 14px;"><strong>Updated Pipeline Stage:</strong> <span style="background-color: ${isRejection ? '#fee2e2' : '#e0e7ff'}; color: ${isRejection ? '#991b1b' : '#3730a3'}; padding: 2px 8px; border-radius: 4px; font-weight: 600;">${escapeHtml(stage)}</span></p>
            ${previousStage ? `<p style="margin: 0; font-size: 13px; color: #64748b;">Previous Stage: ${escapeHtml(previousStage)}</p>` : ''}
          </div>
          <p style="font-size: 15px; margin-bottom: 16px;">${stageMessage}</p>
          ${interviewHtml}
          ${notes}
          <p style="font-size: 15px; margin-bottom: 0;">Our talent acquisition team will keep you informed as we proceed through the process.</p>
        `
      });

      const text = `Orbit | Mechlin Technologies\n=================================\n\nDear ${candidateName},\n\nWe would like to share an update regarding your application for the ${reqTitle} position${team}.\n\nUpdated Pipeline Stage: ${stage}${previousStage ? ` (Previous: ${previousStage})` : ''}\n\n${stageMessage}\n${interviewText}${vars.notes ? `\nNote from Hiring Team:\n${vars.notes}\n` : ''}Our talent acquisition team will keep you informed as we proceed through the process.\n\nWarm regards,\nThe Mechlin Talent Team`;

      return { subject, html, text };
    }
  },
  pre_onboarding_training: {
    id: 'pre_onboarding_training',
    name: 'Pre-Onboarding Training Plan',
    category: 'training',
    isEssential: true,
    render(vars) {
      if (vars.html && vars.text) {
        return {
          subject: vars.subject || 'Pre-Onboarding Training Plan',
          html: vars.html,
          text: vars.text
        };
      }
      const candidateName = vars.candidate_name || 'Candidate';
      const reqTitle = vars.requisition_title || vars.position || 'Position';
      const planName = vars.training_plan_name || vars.plan_name || 'Pre-Onboarding Training Plan';
      const intro = vars.introduction || 'Welcome to Mechlin! We have prepared this pre-onboarding training plan to support your preparation prior to your start date.';
      const objectives = vars.objectives || '';
      const duration = vars.duration_text || vars.duration || '';
      const supportName = vars.support_contact_name || vars.contact_name || 'The Mechlin Talent Team';
      const supportEmail = vars.support_contact_email || vars.contact_email || 'hr@mechlintech.com';

      const title = vars.subject || `Pre-Onboarding Training Plan: ${reqTitle}`;
      const subject = title;

      let sectionsHtml = '';
      if (Array.isArray(vars.sections) && vars.sections.length > 0) {
        sectionsHtml = vars.sections.map((s, idx) => `
          <div style="margin-bottom: 20px; background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px;">
            <h3 style="margin-top: 0; margin-bottom: 8px; font-size: 15px; font-weight: 600; color: #0f172a;">${escapeHtml(s.title || `Section ${idx + 1}`)}</h3>
            <p style="margin: 0; font-size: 14px; color: #334155; line-height: 1.5; white-space: pre-wrap;">${escapeHtml(s.content || '')}</p>
          </div>
        `).join('');
      }

      let linksHtml = '';
      if (Array.isArray(vars.learning_links) && vars.learning_links.length > 0) {
        linksHtml = `
          <div style="margin-top: 24px;">
            <h3 style="font-size: 14px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; color: #64748b; margin-bottom: 12px;">Recommended Learning Links & Resources</h3>
            ${vars.learning_links.map(l => `
              <div style="margin-bottom: 10px; padding: 12px; background: #ffffff; border: 1px solid #cbd5e1; border-radius: 6px;">
                <a href="${escapeHtml(l.url)}" style="font-weight: 600; color: #0284c7; text-decoration: none; font-size: 14px;">${escapeHtml(l.title || l.url)} &rarr;</a>
                ${l.description ? `<p style="margin: 4px 0 0 0; font-size: 13px; color: #475569;">${escapeHtml(l.description)}</p>` : ''}
              </div>
            `).join('')}
          </div>
        `;
      }

      const html = baseLayout({
        title,
        candidateName,
        isOperational: true,
        bodyHtml: `
          <p style="font-size: 15px; margin-bottom: 16px;">Dear ${escapeHtml(candidateName)},</p>
          <p style="font-size: 15px; margin-bottom: 16px;">${escapeHtml(intro)}</p>
          <div style="background-color: #f1f5f9; border-radius: 8px; padding: 16px; margin: 20px 0;">
            <p style="margin: 0 0 6px 0; font-size: 14px;"><strong>Target Position:</strong> ${escapeHtml(reqTitle)}</p>
            <p style="margin: 0 0 6px 0; font-size: 14px;"><strong>Training Plan:</strong> ${escapeHtml(planName)}</p>
            ${duration ? `<p style="margin: 0; font-size: 13px; color: #64748b;"><strong>Duration:</strong> ${escapeHtml(duration)}</p>` : ''}
          </div>
          ${objectives ? `
            <div style="background-color: #eff6ff; border-left: 4px solid #3b82f6; border-radius: 4px; padding: 14px 16px; margin: 20px 0;">
              <h4 style="margin: 0 0 8px 0; font-size: 14px; color: #1e40af;">Training Objectives & Learning Outcomes</h4>
              <p style="margin: 0; font-size: 14px; color: #1e3a8a; line-height: 1.5; white-space: pre-wrap;">${escapeHtml(objectives)}</p>
            </div>
          ` : ''}
          ${sectionsHtml}
          ${linksHtml}
          <div style="margin-top: 24px; padding: 14px; background-color: #f8fafc; border-radius: 8px; border: 1px solid #e2e8f0; font-size: 13px; color: #475569;">
            <strong>Need Assistance?</strong> For questions regarding this training plan, please reach out to ${escapeHtml(supportName)} at <a href="mailto:${escapeHtml(supportEmail)}" style="color: #0284c7;">${escapeHtml(supportEmail)}</a>.
          </div>
        `
      });

      const text = `Dear ${candidateName},\n\n${intro}\n\nPosition: ${reqTitle}\nTraining Plan: ${planName}${duration ? `\nDuration: ${duration}` : ''}\n\n${objectives ? `Objectives:\n${objectives}\n\n` : ''}${Array.isArray(vars.sections) ? vars.sections.map((s, i) => `${i + 1}. ${s.title}\n${s.content}\n`).join('\n') : ''}\nSupport Contact: ${supportName} (${supportEmail})\n\nWarm regards,\nThe Mechlin Talent Team`;

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

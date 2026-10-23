/**
 * Microsoft Graph API Client for Project Orbit.
 * Handles OAuth2 client credentials token acquisition, Outlook calendar events,
 * and Microsoft Teams online meeting creation.
 */

// In-memory token cache to prevent unnecessary token calls
let cachedToken = null;
let tokenExpiresAt = 0;

/**
 * Acquires a Microsoft Graph application access token via client credentials.
 */
export async function getGraphAccessToken({ tenant, client, secret, transport = fetch, forceRefresh = false }) {
  if (!tenant || !client || !secret) {
    throw new Error('Microsoft Graph credentials (tenant, client, secret) are missing.');
  }

  const now = Date.now();
  if (!forceRefresh && cachedToken && tokenExpiresAt > now + 60000) {
    return cachedToken;
  }

  const tokenUrl = `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`;
  const bodyParams = new URLSearchParams({
    client_id: client,
    client_secret: secret,
    scope: 'https://graph.microsoft.com/.default',
    grant_type: 'client_credentials'
  });

  const res = await transport(tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: bodyParams.toString(),
    signal: AbortSignal.timeout(10000)
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Microsoft Graph token acquisition failed (HTTP ${res.status}): ${errText}`);
  }

  const data = await res.json();
  if (!data.access_token) {
    throw new Error('Microsoft Graph token response missing access_token.');
  }

  cachedToken = data.access_token;
  tokenExpiresAt = now + (Number(data.expires_in) || 3600) * 1000;
  return cachedToken;
}

export function resetGraphTokenCache() {
  cachedToken = null;
  tokenExpiresAt = 0;
}

/**
 * Creates an Outlook calendar event with an integrated Microsoft Teams online meeting.
 */
export async function createTeamsMeetingEvent({
  token,
  organizerEmail,
  subject,
  bodyHtml = '',
  startsAt,
  endsAt,
  timeZone = 'Asia/Kolkata',
  attendees = [],
  transport = fetch
}) {
  if (!organizerEmail) {
    throw new Error('Organizer email is required to create a Microsoft Graph calendar event.');
  }

  const userEndpoint = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(organizerEmail)}/events`;

  const payload = {
    subject: subject || 'Interview',
    body: {
      contentType: 'HTML',
      content: bodyHtml
    },
    start: {
      dateTime: startsAt.endsWith('Z') ? startsAt.slice(0, -1) : startsAt,
      timeZone: timeZone || 'Asia/Kolkata'
    },
    end: {
      dateTime: endsAt.endsWith('Z') ? endsAt.slice(0, -1) : endsAt,
      timeZone: timeZone || 'Asia/Kolkata'
    },
    attendees: attendees.map(a => ({
      emailAddress: {
        address: a.email,
        name: a.name || a.email
      },
      type: a.type || 'required'
    })),
    isOnlineMeeting: true,
    onlineMeetingProvider: 'teamsForBusiness'
  };

    const outlookTz = (timeZone === 'Asia/Kolkata' || timeZone === 'Asia/Calcutta' || timeZone === 'IST') ? 'India Standard Time' : (timeZone || 'UTC');
    const res = await transport(userEndpoint, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Prefer': `outlook.timezone="${outlookTz}"`
      },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10000)
  });

  if (!res.ok) {
    const errData = await res.json().catch(() => ({}));
    const message = errData.error?.message || `HTTP ${res.status} ${res.statusText}`;
    const err = new Error(`Microsoft Graph event creation failed: ${message}`);
    err.status = res.status;
    throw err;
  }

  const data = await res.json();
  const joinUrl = data.onlineMeeting?.joinUrl || data.webLink || null;

  return {
    id: data.id,
    joinUrl,
    webLink: data.webLink || null,
    subject: data.subject,
    start: data.start,
    end: data.end
  };
}

/**
 * Updates an existing calendar event (for rescheduling).
 */
export async function updateTeamsMeetingEvent({
  token,
  organizerEmail,
  eventId,
  subject,
  bodyHtml,
  startsAt,
  endsAt,
  timeZone = 'Asia/Kolkata',
  attendees,
  transport = fetch
}) {
  if (!organizerEmail || !eventId) {
    throw new Error('Organizer email and eventId are required to update a Microsoft Graph calendar event.');
  }

  const eventEndpoint = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(organizerEmail)}/events/${encodeURIComponent(eventId)}`;

  const payload = {};
  if (subject) payload.subject = subject;
  if (bodyHtml !== undefined) {
    payload.body = { contentType: 'HTML', content: bodyHtml };
  }
  if (startsAt) {
    payload.start = {
      dateTime: startsAt.endsWith('Z') ? startsAt.slice(0, -1) : startsAt,
      timeZone: timeZone || 'Asia/Kolkata'
    };
  }
  if (endsAt) {
    payload.end = {
      dateTime: endsAt.endsWith('Z') ? endsAt.slice(0, -1) : endsAt,
      timeZone: timeZone || 'Asia/Kolkata'
    };
  }
  if (attendees) {
    payload.attendees = attendees.map(a => ({
      emailAddress: { address: a.email, name: a.name || a.email },
      type: a.type || 'required'
    }));
  }

    const outlookTz = (timeZone === 'Asia/Kolkata' || timeZone === 'Asia/Calcutta' || timeZone === 'IST') ? 'India Standard Time' : (timeZone || 'UTC');
    const res = await transport(eventEndpoint, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Prefer': `outlook.timezone="${outlookTz}"`
      },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10000)
  });

  if (!res.ok) {
    const errData = await res.json().catch(() => ({}));
    const message = errData.error?.message || `HTTP ${res.status} ${res.statusText}`;
    const err = new Error(`Microsoft Graph event update failed: ${message}`);
    err.status = res.status;
    throw err;
  }

  const data = await res.json().catch(() => ({}));
  return {
    id: data.id || eventId,
    joinUrl: data.onlineMeeting?.joinUrl || null,
    webLink: data.webLink || null
  };
}

/**
 * Cancels or removes an existing calendar event.
 */
export async function cancelTeamsMeetingEvent({
  token,
  organizerEmail,
  eventId,
  comment = 'Interview cancelled',
  transport = fetch
}) {
  if (!organizerEmail || !eventId) {
    throw new Error('Organizer email and eventId are required to cancel a Microsoft Graph calendar event.');
  }

  const cancelEndpoint = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(organizerEmail)}/events/${encodeURIComponent(eventId)}/cancel`;

  const res = await transport(cancelEndpoint, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ comment }),
    signal: AbortSignal.timeout(10000)
  });

  // Microsoft Graph returns 202 Accepted on event cancel
  if (!res.ok && res.status !== 404) {
    const errData = await res.json().catch(() => ({}));
    const message = errData.error?.message || `HTTP ${res.status} ${res.statusText}`;
    const err = new Error(`Microsoft Graph event cancellation failed: ${message}`);
    err.status = res.status;
    throw err;
  }

  return { cancelled: true };
}

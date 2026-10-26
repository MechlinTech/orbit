import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { fixture, user, reqBody, candidateBody } from './helpers.js';
import { service } from '../src/service.js';
import { renderTemplate } from '../src/communication/templates.js';
import { syncScheduleMeeting, syncRescheduleMeeting } from '../src/calendar/service.js';
import { createTeamsMeetingEvent } from '../src/calendar/graph.js';

const call = (f, u, m, p, b) => service(f.db, u, m, p, b);

function hiringFixture() {
  const f = fixture();
  f.req = call(f, f.recruiter, 'POST', 'requisitions', reqBody);
  call(f, f.recruiter, 'POST', `requisitions/${f.req.id}/submit`);
  call(f, f.manager, 'POST', `requisitions/${f.req.id}/approve`, {});
  call(f, f.finance, 'POST', `requisitions/${f.req.id}/approve`, {});
  f.candidate = call(f, f.recruiter, 'POST', 'candidates', candidateBody);
  f.app = call(f, f.recruiter, 'POST', 'applications', { candidate_id: f.candidate.id, requisition_id: f.req.id });
  return f;
}

test('Physical / In-Person Interview: templates render venue and omit meeting links', () => {
  const vars = {
    candidate_name: 'Alex Johnson',
    requisition_title: 'Senior Frontend Engineer',
    scheduled_at: '2026-11-01T14:00:00.000Z',
    duration_minutes: 60,
    timezone: 'Asia/Kolkata',
    interviewer_name: 'Priya Sharma',
    interview_type: 'in_person',
    location: 'Mechlin Technologies — Corporate HQ, Mohali',
    notes: 'Please bring your laptop for the technical discussion.'
  };

  const invite = renderTemplate('interview_invitation', vars);
  assert.ok(invite.html.includes('In-Person / Physical Interview'), 'HTML should indicate in-person interview format');
  assert.ok(invite.html.includes('Mechlin Technologies — Corporate HQ, Mohali'), 'HTML should include physical location');
  assert.ok(!invite.html.includes('Join Microsoft Teams Meeting'), 'HTML should NOT contain Teams meeting button');
  assert.ok(!invite.html.includes('Meeting Link:'), 'HTML should NOT contain meeting link');
  assert.ok(invite.text.includes('Format: In-Person / Physical'), 'Text should include format');
  assert.ok(invite.text.includes('Location / Venue: Mechlin Technologies — Corporate HQ, Mohali'), 'Text should include venue');
  assert.ok(!invite.text.includes('Microsoft Teams Meeting Link:'), 'Text should NOT contain Teams join link');

  const update = renderTemplate('interview_update', vars);
  assert.ok(update.html.includes('In-Person / Physical Interview'), 'Update HTML should indicate in-person interview format');
  assert.ok(update.html.includes('Mechlin Technologies — Corporate HQ, Mohali'), 'Update HTML should include physical location');
  assert.ok(!update.html.includes('Join Microsoft Teams Meeting'), 'Update HTML should NOT contain Teams meeting button');
  assert.ok(!update.text.includes('Microsoft Teams Meeting Link:'), 'Update text should NOT contain Teams link');
});

test('Physical / In-Person Interview: POST /api/interviews persists format and sets meeting_url to null', async () => {
  const f = hiringFixture();
  const futureDate = new Date(Date.now() + 86400000 * 2).toISOString();

  // Create an in-person interview
  const interview = call(f, f.recruiter, 'POST', 'interviews', {
    application_id: f.app.id,
    interviewer_id: f.interviewer.id,
    scheduled_at: futureDate,
    competencies: ['Architecture', 'Problem Solving'],
    interview_type: 'in_person',
    location: 'Mechlin HQ, Floor 4, Boardroom A',
    notes: 'Report to reception upon arrival'
  });

  assert.equal(interview.interview_type, 'in_person');
  assert.equal(interview.location, 'Mechlin HQ, Floor 4, Boardroom A');
  assert.equal(interview.meeting_url, null, 'meeting_url should be null for in-person interview');

  // Verify in database
  const row = f.db.prepare('SELECT * FROM interviews WHERE id=?').get(interview.id);
  assert.equal(row.interview_type, 'in_person');
  assert.equal(row.location, 'Mechlin HQ, Floor 4, Boardroom A');
  assert.equal(row.meeting_url, null);

  // Edit the interview and keep it in-person
  const updatedFuture = new Date(Date.now() + 86400000 * 3).toISOString();
  const updated = call(f, f.recruiter, 'PUT', `interviews/${interview.id}`, {
    scheduled_at: updatedFuture,
    location: 'Mechlin HQ, Floor 2, Room 204'
  });

  assert.equal(updated.interview_type, 'in_person');
  assert.equal(updated.location, 'Mechlin HQ, Floor 2, Room 204');
  assert.equal(updated.meeting_url, null, 'meeting_url remains null');
  f.db.close();
});

test('Physical / In-Person Interview: Switching between virtual and in-person toggles meeting_url', async () => {
  const f = hiringFixture();
  const futureDate = new Date(Date.now() + 86400000 * 2).toISOString();

  // 1. Create a virtual interview with meeting_url
  const virtualInterview = call(f, f.recruiter, 'POST', 'interviews', {
    application_id: f.app.id,
    interviewer_id: f.interviewer.id,
    scheduled_at: futureDate,
    competencies: ['System Design'],
    interview_type: 'virtual',
    meeting_url: 'https://teams.microsoft.com/l/meetup-join/test-room'
  });

  assert.equal(virtualInterview.interview_type, 'virtual');
  assert.equal(virtualInterview.meeting_url, 'https://teams.microsoft.com/l/meetup-join/test-room');

  // 2. Switch to in-person: meeting_url should be cleared to null
  const switchedToPhysical = call(f, f.recruiter, 'PUT', `interviews/${virtualInterview.id}`, {
    scheduled_at: futureDate,
    interview_type: 'in_person',
    location: 'Mechlin Corporate Office, Mohali'
  });

  assert.equal(switchedToPhysical.interview_type, 'in_person');
  assert.equal(switchedToPhysical.location, 'Mechlin Corporate Office, Mohali');
  assert.equal(switchedToPhysical.meeting_url, null, 'Switching to in-person clears meeting_url to null');

  const row = f.db.prepare('SELECT meeting_url, interview_type FROM interviews WHERE id=?').get(virtualInterview.id);
  assert.equal(row.interview_type, 'in_person');
  assert.equal(row.meeting_url, null);

  // 3. Switch back to virtual with meeting_url
  const switchedToVirtual = call(f, f.recruiter, 'PUT', `interviews/${virtualInterview.id}`, {
    scheduled_at: futureDate,
    interview_type: 'virtual',
    meeting_url: 'https://teams.microsoft.com/l/meetup-join/new-test-room'
  });

  assert.equal(switchedToVirtual.interview_type, 'virtual');
  assert.equal(switchedToVirtual.meeting_url, 'https://teams.microsoft.com/l/meetup-join/new-test-room');
  f.db.close();
});

test('Physical / In-Person Interview: Calendar sync passes isOnlineMeeting false and location', async () => {
  const f = hiringFixture();
  const scheduledAt = new Date(Date.now() + 86400000 * 2).toISOString();

  const interview = call(f, f.recruiter, 'POST', 'interviews', {
    application_id: f.app.id,
    interviewer_id: f.interviewer.id,
    scheduled_at: scheduledAt,
    competencies: ['Coding'],
    interview_type: 'in_person',
    location: 'Mechlin Tower A'
  });

  // Test syncScheduleMeeting with in-person format in demo mode
  const demoResult = await syncScheduleMeeting({
    db: f.db,
    user: f.recruiter,
    interviewId: interview.id,
    scheduledAt,
    candidate: f.candidate,
    req: f.req,
    interviewer: f.interviewer,
    interviewType: 'in_person',
    location: 'Mechlin Tower A',
    config: {
      entraTenantId: 'demo-tenant',
      entraClientId: 'demo-client',
      entraClientSecret: 'demo-secret',
      teamsOrganizerEmail: 'recruiter@mechlin.com'
    }
  });

  assert.equal(demoResult.synced, true);
  assert.equal(demoResult.meeting_url, null, 'In-person interview in demo calendar sync returns null meeting_url');

  // Test createTeamsMeetingEvent with isOnlineMeeting: false
  let capturedPayload = null;
  const mockTransport = async (url, options) => {
    capturedPayload = JSON.parse(options.body);
    return {
      ok: true,
      status: 201,
      json: async () => ({
        id: 'graph-event-physical-123',
        subject: capturedPayload.subject,
        start: capturedPayload.start,
        end: capturedPayload.end,
        webLink: 'https://outlook.office365.com/event/123'
      })
    };
  };

  const graphEvent = await createTeamsMeetingEvent({
    token: 'test-token',
    organizerEmail: 'recruiter@mechlin.com',
    subject: 'In-Person Round: Candidate Interview',
    startsAt: scheduledAt,
    endsAt: new Date(Date.now() + 86400000 * 2 + 3600000).toISOString(),
    attendees: [{ email: 'cand@test.com', name: 'Candidate' }],
    isOnlineMeeting: false,
    location: 'Mechlin Tower A, Floor 3',
    transport: mockTransport
  });

  assert.equal(capturedPayload.isOnlineMeeting, false);
  assert.equal(capturedPayload.location.displayName, 'Mechlin Tower A, Floor 3');
  assert.equal(capturedPayload.onlineMeetingProvider, undefined);
  assert.equal(graphEvent.joinUrl, null, 'Graph event joinUrl is null for in-person meetings');
  f.db.close();
});

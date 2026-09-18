/** Provider-neutral contracts. No stub sends data or reports false success. */
export class AdapterNotConfigured extends Error { constructor(capability) { super(`${capability} adapter is not configured`); this.code='ADAPTER_NOT_CONFIGURED'; } }
export class CalendarAdapter { async schedule({applicationId,attendees,startsAt,endsAt,idempotencyKey}) { throw new AdapterNotConfigured('Calendar'); } async cancel({providerEventId,idempotencyKey}) { throw new AdapterNotConfigured('Calendar'); } }
export class CommunicationAdapter { async send({candidateId,channel,templateId,variables,idempotencyKey,consentReference}) { throw new AdapterNotConfigured('Communication'); } }
export class SignatureAdapter { async request({offerId,documentReference,signers,idempotencyKey}) { throw new AdapterNotConfigured('E-signature'); } async verifyWebhook({rawBody,headers}) { throw new AdapterNotConfigured('E-signature webhook verification'); } }
export class HrmsAdapter { async handoff({hireId,approvedFields,idempotencyKey}) { throw new AdapterNotConfigured('HRMS'); } }
export class ResumeAdapter { async parse({quarantinedFileReference,mimeType}) { throw new AdapterNotConfigured('Resume parsing'); } }
export class MatchingAdapter { async explain({candidateSkills,jobCriteria,modelVersion}) { throw new AdapterNotConfigured('AI matching'); } }
export class FraudAdapter { async flag({applicationId,evidenceReferences}) { throw new AdapterNotConfigured('Fraud review'); } }

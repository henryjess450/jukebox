/** Admin auth pieces and form parsing. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import bcrypt from 'bcryptjs';
import { AdminSessions, verifyAdminPassword } from '../src/routes/admin/auth.js';
import { csrfToken, csrfValid } from '../src/http/csrf.js';
import { parseSettingsForm } from '../src/routes/admin/index.js';
import { escapeHtml, html, raw } from '../src/http/html.js';

describe('verifyAdminPassword', () => {
  it('accepts the right password and rejects everything else', async () => {
    const hash = await bcrypt.hash('correct horse battery', 10);
    assert.equal(await verifyAdminPassword('correct horse battery', hash), true);
    assert.equal(await verifyAdminPassword('wrong', hash), false);
    assert.equal(await verifyAdminPassword('', hash), false);
  });

  it('returns false rather than throwing on a malformed hash', async () => {
    assert.equal(await verifyAdminPassword('anything', 'not-a-hash'), false);
  });
});

describe('AdminSessions', () => {
  it('validates only ids it issued', () => {
    const sessions = new AdminSessions();
    const id = sessions.create();
    assert.equal(sessions.isValid(id), true);
    assert.equal(sessions.isValid('made-up'), false);
    assert.equal(sessions.isValid(undefined), false);
  });

  it('stops validating a destroyed session', () => {
    const sessions = new AdminSessions();
    const id = sessions.create();
    sessions.destroy(id);
    assert.equal(sessions.isValid(id), false);
  });
});

describe('csrf', () => {
  const secret = 'y'.repeat(48);

  it('accepts a token bound to the same session', () => {
    const token = csrfToken('session-a', secret);
    assert.equal(csrfValid('session-a', secret, token), true);
  });

  it('rejects a token from another session or another secret', () => {
    const token = csrfToken('session-a', secret);
    assert.equal(csrfValid('session-b', secret, token), false);
    assert.equal(csrfValid('session-a', 'z'.repeat(48), token), false);
  });

  it('rejects missing and non-string tokens', () => {
    assert.equal(csrfValid('session-a', secret, undefined), false);
    assert.equal(csrfValid('session-a', secret, ''), false);
    assert.equal(csrfValid('session-a', secret, 42), false);
  });
});

describe('parseSettingsForm', () => {
  it('treats an absent checkbox as false', () => {
    const patch = parseSettingsForm({ venue_name: 'Bar' });
    assert.equal(patch.free_mode, false);
    assert.equal(patch.accepting_requests, false);
    assert.equal(patch.block_duplicates, false);
  });

  it('reads a checked checkbox as true', () => {
    const patch = parseSettingsForm({ free_mode: 'true', explicit_filter: 'on' });
    assert.equal(patch.free_mode, true);
    assert.equal(patch.explicit_filter, true);
  });

  it('coerces numeric fields', () => {
    const patch = parseSettingsForm({ price_cents: '250', volume_percent: '80' });
    assert.equal(patch.price_cents, 250);
    assert.equal(patch.volume_percent, 80);
  });

  it('passes a non-numeric value through so Zod reports it', () => {
    const patch = parseSettingsForm({ price_cents: 'free' });
    assert.equal(patch.price_cents, 'free');
  });

  it('skips empty numeric fields rather than writing zero', () => {
    const patch = parseSettingsForm({ price_cents: '' });
    assert.equal('price_cents' in patch, false);
  });

  it('trims text fields and ignores an unknown currency', () => {
    const patch = parseSettingsForm({ venue_name: '  The Back Room  ', currency: 'XBT' });
    assert.equal(patch.venue_name, 'The Back Room');
    assert.equal('currency' in patch, false);
  });
});

describe('html escaping', () => {
  it('escapes interpolated values', () => {
    const evil = '<script>alert(1)</script>';
    assert.equal(
      html`<p>${evil}</p>`.value,
      '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>',
    );
  });

  it('escapes quotes so attribute injection fails', () => {
    assert.equal(escapeHtml(`" onload="x`), '&quot; onload=&quot;x');
  });

  it('passes raw() through untouched and joins arrays', () => {
    assert.equal(html`${raw('<b>ok</b>')}`.value, '<b>ok</b>');
    assert.equal(html`${[raw('<i>'), 'a&b', raw('</i>')]}`.value, '<i>a&amp;b</i>');
  });

  it('renders null, undefined and false as nothing', () => {
    assert.equal(html`[${null}${undefined}${false}]`.value, '[]');
  });
});

// Phase 12C — verify the OTP "resend code" UX on the verification page.
// Drives the real signup flow in a browser and asserts the new elements exist
// and behave: expiry countdown, always-visible resend button with 30s cooldown,
// and the "start over" link. Captures screenshots for the record.
const { chromium } = require('playwright');

(async () => {
  const email = `uitest_${Date.now()}@example.com`;
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 460, height: 900 } });
  const fails = [];
  const ok = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'} — ${msg}`); if (!cond) fails.push(msg); };

  await page.goto('http://localhost:3000/register');
  await page.fill('#inp-email', email);
  await page.click('#submit-btn');                       // send verification code
  await page.waitForSelector('#otp-expiry');

  // 1. Expiry countdown is shown and counting in m:ss.
  const expiryText = (await page.textContent('#otp-expiry')).trim();
  ok(/^Code expires in \d+:\d{2}$/.test(expiryText), `expiry countdown shown ("${expiryText}")`);

  // 2. Resend button is always visible, disabled during the 30s cooldown.
  const resendBtn = page.locator('#resend-btn');
  ok(await resendBtn.isVisible(), 'resend button visible');
  ok(await resendBtn.isDisabled(), 'resend button disabled during cooldown');
  const cooldownText = (await resendBtn.textContent()).trim();
  ok(/^Resend code in \d+s$/.test(cooldownText), `cooldown label shown ("${cooldownText}")`);

  // 3. Start-over link present.
  const startOver = page.getByText('Already verified or want to start over?');
  ok(await startOver.isVisible(), 'start-over link visible');

  await page.screenshot({ path: 'screenshots/phase12c/01-otp-cooldown.png' });

  // 4. Force the cooldown to elapse (don't wait 30s of wall clock) and confirm
  //    the button becomes enabled and clickable.
  await page.evaluate(() => { State.resendSeconds = 0; clearResendTimer(); updateResendUI(); });
  ok(await resendBtn.isEnabled(), 'resend button enabled after cooldown');

  // 5. Simulate expiry: button gains prominence + expiry line flips to expired.
  await page.evaluate(() => {
    State.expirySeconds = 0; clearExpiryTimer(); State.codeExpired = true;
    clearResendTimer(); State.resendSeconds = 0; updateResendUI(); updateExpiryUI();
  });
  ok((await page.textContent('#otp-expiry')).includes('expired'), 'expiry line shows expired state');
  ok(await resendBtn.evaluate(el => el.classList.contains('resend-prominent')), 'resend button is prominent after expiry');
  await page.screenshot({ path: 'screenshots/phase12c/02-otp-expired.png' });

  // 6. Click resend → confirmation message + cooldown restarts.
  await resendBtn.click();
  await page.waitForSelector('#msg.show.msg-success');
  const msg = (await page.textContent('#msg')).trim();
  ok(msg === 'New code sent. Check your email or logs.', `confirmation message ("${msg}")`);
  ok(await resendBtn.isDisabled(), 'resend button re-disabled after clicking (cooldown restarted)');
  await page.screenshot({ path: 'screenshots/phase12c/03-after-resend.png' });

  // 7. Start-over returns to the signup email form.
  await page.evaluate(() => { State.resendSeconds = 0; clearResendTimer(); updateResendUI(); });
  await page.getByText('Already verified or want to start over?').click();
  await page.waitForSelector('#register-email-form');
  ok(await page.locator('#register-email-form').isVisible(), 'start-over returns to signup form');

  await browser.close();
  console.log(fails.length ? `\n${fails.length} FAILURE(S)` : '\nALL CHECKS PASSED');
  process.exit(fails.length ? 1 : 0);
})();

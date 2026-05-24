// Stripe integration — drop in your keys to activate.
// Install: npm install stripe
// Uncomment the Stripe lines and implement the webhook handler.

// const Stripe = require('stripe');
// const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const PLANS = {
  free: {
    name: 'Free',
    price: 0,
    maxCompetitors: 1,
    automaticChecks: false,
    webhooks: false,
    stripePriceId: null,
    features: ['1 competitor URL', 'Manual checks only', 'Basic briefs', 'Community support'],
  },
  pro: {
    name: 'Pro',
    price: 20,
    maxCompetitors: 10,
    automaticChecks: true,
    webhooks: true,
    stripePriceId: process.env.STRIPE_PRO_PRICE_ID,
    features: ['10 competitor URLs', 'Daily automatic checks', 'Slack & Discord alerts', 'Full AI briefs', 'Priority support'],
  },
  team: {
    name: 'Team',
    price: 49,
    maxCompetitors: -1,
    automaticChecks: true,
    webhooks: true,
    multipleWebhooks: true,
    stripePriceId: process.env.STRIPE_TEAM_PRICE_ID,
    features: ['Unlimited competitor URLs', 'Daily automatic checks', 'Multiple webhook channels', 'Team dashboard', 'API access', 'Dedicated support'],
  },
};

async function createCheckoutSession(userId, plan, userEmail) {
  if (!process.env.STRIPE_SECRET_KEY) {
    throw new Error('STRIPE_SECRET_KEY not configured');
  }
  // const session = await stripe.checkout.sessions.create({
  //   payment_method_types: ['card'],
  //   customer_email: userEmail,
  //   line_items: [{ price: PLANS[plan].stripePriceId, quantity: 1 }],
  //   mode: 'subscription',
  //   success_url: `${process.env.APP_URL}/settings?upgraded=true&plan=${plan}`,
  //   cancel_url: `${process.env.APP_URL}/pricing`,
  //   metadata: { userId: String(userId), plan },
  // });
  // return session.url;
  throw new Error('Stripe not yet configured. Add STRIPE_SECRET_KEY to .env to enable payments.');
}

async function handleStripeWebhook(rawBody, signature) {
  // const event = stripe.webhooks.constructEvent(rawBody, signature, process.env.STRIPE_WEBHOOK_SECRET);
  // switch (event.type) {
  //   case 'checkout.session.completed': {
  //     const { userId, plan } = event.data.object.metadata;
  //     const db = require('./db').getDb();
  //     db.prepare('UPDATE users SET tier = ?, stripe_subscription_id = ? WHERE id = ?')
  //       .run(plan, event.data.object.subscription, userId);
  //     break;
  //   }
  //   case 'customer.subscription.deleted': {
  //     const sub = event.data.object;
  //     const db = require('./db').getDb();
  //     db.prepare('UPDATE users SET tier = ? WHERE stripe_subscription_id = ?').run('free', sub.id);
  //     break;
  //   }
  // }
}

function getPlan(tier) {
  return PLANS[tier] || PLANS.free;
}

function canAddCompetitor(user, currentCount) {
  const plan = getPlan(user.tier);
  if (plan.maxCompetitors === -1) return true;
  return currentCount < plan.maxCompetitors;
}

function canRunAutomaticChecks(user) {
  return getPlan(user.tier).automaticChecks;
}

function canUseWebhooks(user) {
  return getPlan(user.tier).webhooks;
}

module.exports = {
  PLANS,
  getPlan,
  createCheckoutSession,
  handleStripeWebhook,
  canAddCompetitor,
  canRunAutomaticChecks,
  canUseWebhooks,
};

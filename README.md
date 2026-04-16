This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://github.com/vercel/next.js/tree/canary/packages/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.js`. The page auto-updates as you edit the file.

## Stripe Billing Setup

Set these environment variables in `.env.local`:

```bash
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
APP_BASE_URL=http://localhost:3000

# Optional billing email alerts from webhooks
RESEND_API_KEY=
```

`$8.99/month` and a `7-day` trial are currently defined inline in `app/api/billing/checkout/route.js`.

Use the billing scripts to ensure your `users` table has billing fields:

```bash
# For fresh setup:
scripts/create-app-users-table.sql
scripts/create-billing-profiles-table.sql

# For existing projects:
scripts/update-users-billing-fields.sql
scripts/create-billing-profiles-table.sql
scripts/backfill-billing-profiles.sql
```

`users.last_seen` is updated when authenticated sessions are refreshed, with a
30-minute throttle to avoid excessive write volume.

Stripe webhook endpoint:

```bash
/api/stripe/webhook
```

Webhook events to enable:

```bash
checkout.session.completed
customer.subscription.created
customer.subscription.updated
customer.subscription.deleted
customer.updated
invoice.paid
invoice.payment_failed
```

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.

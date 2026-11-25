import { stripe } from '@/lib/stripe';

export async function refund(paymentIntent: string) {
  return stripe.refunds.create({ payment_intent: paymentIntent });
}

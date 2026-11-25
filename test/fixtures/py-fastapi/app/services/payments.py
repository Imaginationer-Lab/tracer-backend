import stripe

from app.core.config import settings

stripe.api_key = settings.stripe_api_key


def create_intent(amount: int):
    return stripe.PaymentIntent.create(amount=amount, currency="krw")

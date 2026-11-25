using Stripe;

namespace DemoStore.Services;

public class PaymentService
{
    public async Task<PaymentIntent> CreateAsync(long amount)
    {
        var service = new PaymentIntentService();
        return await service.CreateAsync(new PaymentIntentCreateOptions { Amount = amount, Currency = "krw" });
    }
}

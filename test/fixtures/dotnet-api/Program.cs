var builder = WebApplication.CreateBuilder(args);

builder.Services.AddHttpClient("shipping", c => c.BaseAddress = new Uri(builder.Configuration["Shipping:BaseUrl"]!));
builder.Services.AddHttpClient<DemoStore.Services.AuthClient>();

var app = builder.Build();
app.Run();

using System.Net.Http.Json;

namespace DemoStore.Services;

public class AuthClient
{
    private readonly HttpClient _http;
    private readonly IConfiguration _config;

    public AuthClient(HttpClient http, IConfiguration config)
    {
        _http = http;
        _config = config;
    }

    public async Task<string> SignInAsync(string email, string password)
    {
        var res = await _http.PostAsJsonAsync($"{_config["Supabase:Url"]}/auth/v1/token?grant_type=password", new { email, password });
        res.EnsureSuccessStatusCode();
        return await res.Content.ReadAsStringAsync();
    }
}

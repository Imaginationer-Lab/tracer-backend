package com.acme.auth;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClientException;
import org.springframework.web.client.RestTemplate;

import java.util.Map;

@Component
public class SupabaseAuthClient {
    private final RestTemplate restTemplate = new RestTemplate();

    @Value("${supabase.url}")
    private String supabaseUrl;

    public String signIn(String email, String password) {
        try {
            return restTemplate.postForObject(supabaseUrl + "/auth/v1/token?grant_type=password", Map.of("email", email, "password", password), String.class);
        } catch (RestClientException e) {
            return null;
        }
    }
}

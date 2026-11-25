package com.acme.shipping;

import org.springframework.cloud.openfeign.FeignClient;
import org.springframework.web.bind.annotation.GetMapping;

@FeignClient(name = "shipping", url = "${partner.shipping-url}")
public interface ShippingClient {
    @GetMapping("/quotes")
    String quote();
}

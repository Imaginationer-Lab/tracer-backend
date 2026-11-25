package com.acme.web;

import com.acme.pay.PaymentService;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class CheckoutController {
    private final PaymentService paymentService;

    public CheckoutController(PaymentService paymentService) {
        this.paymentService = paymentService;
    }

    @PostMapping("/checkout")
    public String checkout(@RequestParam long amount) throws Exception {
        return paymentService.create(amount).getClientSecret();
    }
}

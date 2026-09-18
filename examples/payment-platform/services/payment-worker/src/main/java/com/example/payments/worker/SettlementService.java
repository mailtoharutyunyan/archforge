package com.example.payments.worker;

import java.time.Instant;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class SettlementService {

    private final SettlementRepository repository;

    public SettlementService(SettlementRepository repository) {
        this.repository = repository;
    }

    @Transactional
    public void settle(PaymentEvent event) {
        Settlement settlement = new Settlement();
        settlement.setPaymentId(event.paymentId());
        settlement.setAmount(event.amount());
        settlement.setCurrency(event.currency());
        settlement.setSettledAt(Instant.now());
        repository.save(settlement);
    }
}

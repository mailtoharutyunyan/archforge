package com.example.payments.api;

import java.time.Instant;
import java.util.Optional;
import java.util.UUID;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Orchestrates payment creation: persist, then announce.
 */
@Service
public class PaymentService {

    private final PaymentRepository repository;
    private final PaymentEventPublisher publisher;

    public PaymentService(PaymentRepository repository, PaymentEventPublisher publisher) {
        this.repository = repository;
        this.publisher = publisher;
    }

    @Transactional
    public Payment create(CreatePaymentRequest request) {
        Payment payment = new Payment(UUID.randomUUID(), request.amount(), request.currency(), "PENDING", Instant.now());
        repository.insert(payment);
        publisher.publishCreated(payment);
        return payment;
    }

    public Optional<Payment> find(UUID id) {
        return repository.findById(id);
    }
}

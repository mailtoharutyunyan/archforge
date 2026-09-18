package com.example.payments.api;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.util.Optional;
import java.util.UUID;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.stereotype.Repository;

/**
 * Plain-SQL persistence for payments.
 */
@Repository
public class PaymentRepository {

    private static final RowMapper<Payment> MAPPER = new PaymentRowMapper();

    private final JdbcTemplate jdbc;

    public PaymentRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    public void insert(Payment payment) {
        jdbc.update(
                "insert into payment (id, amount, currency, status, created_at) values (?, ?, ?, ?, ?)",
                payment.id(), payment.amount(), payment.currency(), payment.status(), Timestamp.from(payment.createdAt()));
    }

    public Optional<Payment> findById(UUID id) {
        return jdbc.query("select * from payment where id = ?", MAPPER, id).stream().findFirst();
    }

    private static final class PaymentRowMapper implements RowMapper<Payment> {
        @Override
        public Payment mapRow(ResultSet rs, int rowNum) throws SQLException {
            return new Payment(
                    rs.getObject("id", UUID.class),
                    rs.getBigDecimal("amount"),
                    rs.getString("currency"),
                    rs.getString("status"),
                    rs.getTimestamp("created_at").toInstant());
        }
    }
}

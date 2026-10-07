-- Separate database for integration tests, so test cleanup never touches dev data.
CREATE DATABASE wagering_test OWNER wagering;

# Bunny command and redaction fixture

This fixture exists only to exercise Bunny Review slash-command dispatch and model redaction.

Expected coverage:

- `/bunny-review full` dispatches the trusted workflow.
- Command status rendering sanitizes unusual command text.
- Model packets redact sensitive-looking changed file paths and values.

Dummy values below are not secrets:

```text
api_key = fake-bunny-test-value
authorization bearer fake-bunny-token
client_secret: fake-bunny-client-secret
```

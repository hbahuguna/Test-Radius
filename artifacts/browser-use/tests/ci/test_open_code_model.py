"""Regression tests for OpenCode Zen model routing."""

from unittest.mock import patch

import server


def test_open_code_model_uses_zen_endpoint_and_key():
    with patch("browser_use.llm.ChatOpenAI") as chat_openai:
        server.get_llm(
            "big-pickle",
            poolside_api_key="poolside-key-must-not-be-used",
            opencode_api_key="opencode-test-key",
            model_provider="opencode",
        )

    chat_openai.assert_called_once_with(
        model="big-pickle",
        base_url="https://opencode.ai/zen/v1",
        api_key="opencode-test-key",
        add_schema_to_system_prompt=True,
        dont_force_structured_output=True,
    )


def test_action_trace_redacts_input_values():
    class InputTextAction:
        def model_dump(self, **_kwargs):
            return {"text": "secret-value", "index": 4}

    class Output:
        action = [InputTextAction()]

    class DomState:
        selector_map = {}

    class BrowserState:
        dom_state = DomState()

    trace = server.format_action_trace(Output(), BrowserState())

    assert trace[0]["raw"]["text"] == "{{TEST_VALUE}}"

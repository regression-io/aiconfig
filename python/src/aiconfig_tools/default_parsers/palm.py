from abc import abstractmethod
import copy
from typing import TYPE_CHECKING, Dict, Optional
from aiconfig_tools.AIConfigSettings import (
    AIConfig,
    ExecuteResult,
    InferenceResponse,
    ModelMetadata,
    Output,
    Prompt,
    PromptMetadata,
)
from aiconfig_tools.default_parsers.parameterized_model_parser import ParameterizedModelParser
from aiconfig_tools.util.config_utils import get_api_key_from_environment
from aiconfig_tools.util.params import resolve_parameters, resolve_prompt, resolve_system_prompt
import google.generativeai as palm

if TYPE_CHECKING:
    from aiconfig_tools.Config import AIConfigRuntime


class PaLMTextParser(ParameterizedModelParser):
    def __init__(self):
        super().__init__()

    def id(self) -> str:
        """
        Returns an identifier for the model (e.g. llama-2, gpt-4, etc.).
        """
        return "PaLM Chat"

    def serialize(
        self,
        prompt_name: str,
        prompt: str,
        model_name: str,
        inference_settings: Dict,
        parameters: Optional[Dict],
        **kwargs
    ) -> Prompt:
        """
        Defines how a prompt and model inference settings get serialized in the .aiconfig.

        Args:
            prompt (str): The prompt to be serialized.
            inference_settings (dict): Model-specific inference settings to be serialized.

        Returns:
            str: Serialized representation of the prompt and inference settings.
        """
        Prompt(
            name=prompt_name,
            input=prompt,
            metadata=PromptMetadata(
                model=ModelMetadata(name=model_name, settings=inference_settings),
                parameters=parameters,
                **kwargs
            ),
        )

    def deserialize(self, prompt: Prompt, aiconfig: AIConfig, params: Optional[Dict] = {}) -> Dict:
        """
        Defines how to parse a prompt in the .aiconfig for a particular model
        and constructs the completion params for that model.

        Args:
            serialized_data (str): Serialized data from the .aiconfig.

        Returns:
            dict: Model-specific completion parameters.
        """
        resolved_prompt = super().deserialize(prompt, aiconfig, params)

        # Build Completion data
        model_settings = aiconfig.get_model_settings(prompt)

        supported_keys = {"maxOutputTokens", "topP", "topK", "model", "temperature"}
        completion_data = {}
        for key in supported_keys:
            if key in model_settings:
                completion_data[key] = model_settings[key]

        # pass in the user prompt
        completion_data["prompt"] = resolved_prompt
        return completion_data

    def run_inference(self, prompt: Prompt, aiconfig, parameters) -> InferenceResponse:
        """
        Invoked to run a prompt in the .aiconfig. This method should perform
        the actual model inference based on the provided prompt and inference settings.

        Args:
            prompt (str): The input prompt.
            inference_settings (dict): Model-specific inference settings.

        Returns:
            InferenceResponse: The response from the model.
        """
        # TODO: check api key here
        completion_data = self.deserialize(prompt, aiconfig, parameters)
        completion = palm.generate_text(**completion_data)

        # construct output object
        output = InferenceResponse(output=completion.predictions[0].content, response=completion)

        prompt.add_output(output)
        return output

    def get_output_text(self, prompt: Prompt, aiconfig) -> str:
        pass


class PaLMChatParser(ParameterizedModelParser):
    def __init__(self):
        super().__init__()

    def id(self) -> str:
        """
        Returns an identifier for the model (e.g. llama-2, gpt-4, etc.).
        """
        return "PaLM Chat"

    def serialize(
        self,
        prompt_name: str,
        prompt: str,
        model_name: str,
        inference_settings: Dict,
        parameters: Optional[Dict],
        **kwargs
    ) -> Prompt:
        """
        Defines how a prompt and model inference settings get serialized in the .aiconfig.

        Args:
            prompt (str): The prompt to be serialized.
            inference_settings (dict): Model-specific inference settings to be serialized.

        Returns:
            str: Serialized representation of the prompt and inference settings.
        """
        Prompt(
            name=prompt_name,
            input=prompt,
            metadata=PromptMetadata(
                model=ModelMetadata(name=model_name, settings=inference_settings),
                parameters=parameters,
                **kwargs
            ),
        )

    async def deserialize(
        self, prompt: Prompt, aiconfig: "AIConfigRuntime", options, params: Optional[Dict] = {}
    ) -> Dict:
        """
        Defines how to parse a prompt in the .aiconfig for a particular model
        and constructs the completion params for that model.

        Args:
            serialized_data (str): Serialized data from the .aiconfig.

        Returns:
            dict: Model-specific completion parameters.
        """
        resolved_prompt = resolve_prompt(prompt, params, aiconfig)

        # Build Completion data
        model_settings = aiconfig.get_model_settings(prompt)

        completion_data = refine_chat_completion_params(model_settings)

        # TODO: handle if user specifies previous messages in settings
        completion_data["messages"] = []

        # Default to always use chat contextjkl;
        if not hasattr(prompt.metadata, "remember_chat_context") or (
            hasattr(prompt.metadata, "remember_chat_context")
            and prompt.metadata.remember_chat_context != False
        ):
            # handle chat history. check previous prompts for the same model. if same model, add prompt and its output to completion data if it has a completed output
            for i, previous_prompt in enumerate(aiconfig.prompts):
                # include prompts upto the current one
                if previous_prompt.name == prompt.name:
                    break

                # check if prompt is of the same model
                if previous_prompt.get_model_name() == self.id():
                    # add prompt and its output to completion data
                    # constructing this prompt will take into account available parameters.

                    # check if prompt has an output. PaLM Api requires this
                    if len(previous_prompt.outputs) > 0:
                        resolved_previous_prompt = resolve_parameters({}, previous_prompt, aiconfig)
                        completion_data["messages"].append(
                            {"content": resolved_previous_prompt, "author": "0"}
                        )

                        completion_data["messages"].append(
                            {
                                "content": aiconfig.get_output_text(
                                    previous_prompt, aiconfig.get_latest_output(previous_prompt)
                                ),
                                "author": "1",
                            }
                        )

        # pass in the user prompt
        completion_data["messages"].append({"content": resolved_prompt, "author": "0"})
        return completion_data

    async def run_inference(self, prompt: Prompt, aiconfig, options, parameters) -> Output:
        """
        Invoked to run a prompt in the .aiconfig. This method should perform
        the actual model inference based on the provided prompt and inference settings.

        Args:
            prompt (str): The input prompt.
            inference_settings (dict): Model-specific inference settings.

        Returns:
            InferenceResponse: The response from the model.
        """
        # TODO: check and handle api key here
        completion_data = await self.deserialize(prompt, aiconfig, options, parameters)
        response = palm.chat(**completion_data)
        outputs = []
        for i, candidate in enumerate(response.candidates):
            output = ExecuteResult(
                **{
                    "output_type": "execute_result",
                    "data": candidate,
                    "execution_count": i,
                    "metadata": {"response": response}
                }
            )
            outputs.append(output)

        prompt.outputs = outputs
        return prompt.outputs

    def get_output_text(
        self, prompt: Prompt, aiconfig: "AIConfigRuntime", output: Optional[Output] = None
    ) -> str:
        if not output:
            output = aiconfig.get_latest_output(prompt)

        if not output:
            return ""

        if output.output_type == "execute_result":
            message = output.data
            if message.get("content"):
                return message.get("content")
            else:
                return ""
        else:
            return ""


def refine_chat_completion_params(model_settings):
    # completion parameters to be used for openai's chat completion api
    # messages handled seperately
    supported_keys = {
        "candidate_count",
        "examples",
        "model",
        "temperature",
        "top_k",
        "top_p",
        "context",
    }

    completion_data = {}
    for key in model_settings:
        if key.lower() in supported_keys:
            completion_data[key.lower()] = model_settings[key]

    return completion_data

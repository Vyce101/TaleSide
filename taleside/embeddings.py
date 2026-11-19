"""Gemini Embedding 2 requests and vector validation."""

import json
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

MODEL = "gemini-embedding-2"
MODEL_001 = "gemini-embedding-001"
PROVIDER = "gemini"
DIMENSIONS = 3072
TOKEN_LIMIT = 8192
MODEL_INFO = {
    "id": MODEL,
    "provider": PROVIDER,
    "provider_name": "Google Gemini",
    "dimensions": DIMENSIONS,
    "max_token_limit": TOKEN_LIMIT,
}
MODELS = {
    MODEL: MODEL_INFO,
    # Embedding 001 reserves eight tokens beyond the text counted by countTokens.
    MODEL_001: {**MODEL_INFO, "id": MODEL_001, "max_token_limit": 2040},
}


def embedding_body(model, dimensions, text):
    content = {"parts": [{"text": text}]}
    if model == MODEL_001:
        return {"content": content, "outputDimensionality": dimensions}
    return {
        "content": content,
        "embedContentConfig": {"outputDimensionality": dimensions, "autoTruncate": False},
    }


class EmbeddingError(Exception):
    """A safe provider error that can be shown in the browser."""


def embedding_input(book_name, text):
    return f"title: {book_name} | text: {text}"


def fit_embedding(book_name, text, token_limit, count):
    tokens = count(embedding_input(book_name, text))
    if tokens <= token_limit:
        return tokens, len(text)
    minimum, maximum = 0, len(text) - 1
    while minimum < maximum:
        middle = (minimum + maximum + 1) // 2
        if count(embedding_input(book_name, text[:middle])) <= token_limit:
            minimum = middle
        else:
            maximum = middle - 1
    if minimum == 0:
        raise EmbeddingError("The book title leaves no room for text in the embedding.")
    return tokens, minimum


def valid_vector(values, dimensions):
    return (
        isinstance(values, list)
        and len(values) == dimensions
        and all(
            type(value) in (int, float) and -3.4028234663852886e38 <= value <= 3.4028234663852886e38
            for value in values
        )
        and any(values)
    )


class Gemini:
    """Use the Gemini Developer REST API directly, without an SDK."""

    def __init__(self, api_key, *, model=MODEL, dimensions=DIMENSIONS):
        self.api_key = api_key
        self.model = model
        self.dimensions = dimensions

    def request(self, method, body):
        request = Request(
            f"https://generativelanguage.googleapis.com/v1beta/models/{self.model}:{method}",
            data=json.dumps(body).encode(),
            headers={"Content-Type": "application/json", "x-goog-api-key": self.api_key},
        )
        try:
            with urlopen(request, timeout=30) as response:
                return json.load(response)
        except HTTPError as error:
            with error:
                if error.code in (401, 403):
                    raise EmbeddingError("Gemini denied access. Check the selected API key in App Settings.") from None
                raise EmbeddingError(f"Gemini {method} returned HTTP {error.code}.") from None
        except (URLError, OSError):
            raise EmbeddingError(f"Could not reach Gemini for {method}.") from None
        except ValueError:
            raise EmbeddingError(f"Gemini returned an invalid {method} response.") from None

    def count(self, text):
        response = self.request("countTokens", {"contents": [{"parts": [{"text": text}]}]})
        total = response.get("totalTokens") if isinstance(response, dict) else None
        if type(total) is not int or total < 1:
            raise EmbeddingError("Gemini returned an invalid token count.")
        return total

    def embed(self, text):
        response = self.request("embedContent", embedding_body(self.model, self.dimensions, text))
        try:
            values = response["embedding"]["values"]
        except (KeyError, TypeError):
            raise EmbeddingError("Gemini did not return an embedding.") from None
        if not valid_vector(values, self.dimensions):
            raise EmbeddingError("Gemini returned an invalid embedding vector.")
        return values

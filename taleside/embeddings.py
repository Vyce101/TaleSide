"""Gemini Embedding 2 requests and vector validation."""

import json
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

MODEL = "gemini-embedding-2"
DIMENSIONS = 3072
TOKEN_LIMIT = 8192


class EmbeddingError(Exception):
    """A safe provider error that can be shown in the browser."""


def embedding_input(book_name, text):
    return f"title: {book_name} | text: {text}"


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
        if not self.api_key:
            raise EmbeddingError("Set GEMINI_API_KEY and restart TaleSide before embedding books.")
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

    def embed(self, text, *, dimensions=None):
        dimensions = self.dimensions if dimensions is None else dimensions
        response = self.request("embedContent", {
            "content": {"parts": [{"text": text}]},
            "embedContentConfig": {"outputDimensionality": dimensions, "autoTruncate": False},
        })
        try:
            values = response["embedding"]["values"]
        except (KeyError, TypeError):
            raise EmbeddingError("Gemini did not return an embedding.") from None
        if not valid_vector(values, dimensions):
            raise EmbeddingError("Gemini returned an invalid embedding vector.")
        return values

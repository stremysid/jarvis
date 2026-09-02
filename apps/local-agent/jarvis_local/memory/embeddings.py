"""Text to vector, with no model download and no network.

Semantic retrieval needs an embedding provider, but the pinned MiniLM model is
an artifact that has to be fetched and hash-verified before it can be trusted.
That acquisition is a separate, explicitly named setup step, so this module
ships a provider built from nothing but the standard library:
`DeterministicHashEmbedder`.

It is deliberately *not* a semantic model -- it is a hashed lexical feature
map. It exists so indexing, ranking, rebuild, and the offline compatibility
gate can be built and proven today, and so a machine that never fetches the
model degrades to shallower retrieval rather than to none.

Determinism is the property every consumer depends on: the same text must
produce byte-identical vectors on every run, in every process, on every
machine. A rebuilt index that ranked differently from the one it replaced
would be indistinguishable from memory corruption. Python's built-in `hash()`
is randomised per process (PYTHONHASHSEED), so it is banned here; every
feature goes through hashlib instead.
"""

from __future__ import annotations

import hashlib
import math
import re
from collections.abc import Iterator, Sequence
from dataclasses import dataclass
from typing import Protocol

from jarvis_local.archive.content_store import normalize_nfc

DEFAULT_DIMENSIONS = 256
DEFAULT_CHAR_NGRAM = 3
DEFAULT_SEED = "jarvis-local-agent/embeddings/v1"

# Word features carry more signal than the character n-grams that back them
# up, so an incidental shared substring ("filing" / "filling") must not outrank
# a real shared word.
_WORD_WEIGHT = 1.0
_CHAR_WEIGHT = 0.5

# `\w+` rather than `[a-z0-9]+`: the archive holds whatever Sid types, and
# dropping every non-ASCII word would silently make those events unsearchable.
_WORD = re.compile(r"\w+")

# Seam for the pinned ONNX model. `AllMiniLmL6V2OnnxEmbedder` will implement
# this same protocol, be returned by `default_embedding_provider()`, and be
# tried by the compatibility gate ahead of the hash embedder. Nothing
# downstream changes when it lands, because every consumer depends on
# `EmbeddingProvider` and on `model_id` -- and a different `model_id`
# invalidates any index built with the old vectors instead of mixing them.
ONNX_MINILM_L6_V2_MODEL_ID = "all-MiniLM-L6-v2"
ONNX_MINILM_L6_V2_DIMENSIONS = 384


class EmbeddingProvider(Protocol):
    """Turns text into vectors of a fixed, self-identifying width."""

    @property
    def model_id(self) -> str:
        """Stable identity of these vectors.

        Every parameter that changes the output must change this string:
        stored vectors are only comparable to vectors from the same model, and
        the index refuses to mix them.
        """
        ...

    @property
    def dimensions(self) -> int:
        """Width of every vector this provider returns."""
        ...

    def embed(self, texts: Sequence[str]) -> list[list[float]]:
        """Embed a batch, returning one vector per input in input order."""
        ...


@dataclass(frozen=True, slots=True)
class DeterministicHashEmbedder:
    """Signed feature hashing over words and character n-grams.

    Collisions are unavoidable when millions of possible features are folded
    into a few hundred buckets. The signs are what make that tolerable: a
    feature contributes `+1` or `-1` based on its own digest, so two colliding
    features cancel as often as they reinforce and the bias stays near zero
    instead of accumulating in one direction.
    """

    dimensions: int = DEFAULT_DIMENSIONS
    char_ngram: int = DEFAULT_CHAR_NGRAM
    seed: str = DEFAULT_SEED

    def __post_init__(self) -> None:
        if self.dimensions < 1:
            raise ValueError(f"dimensions must be positive: {self.dimensions}")
        if self.char_ngram < 1:
            raise ValueError(f"char_ngram must be positive: {self.char_ngram}")

    @property
    def model_id(self) -> str:
        # The seed is digested rather than interpolated: it is free text, and
        # the model id ends up in a database column and in gate reports.
        seed_digest = hashlib.sha256(self.seed.encode("utf-8")).hexdigest()[:12]
        return f"deterministic-hash-v1-d{self.dimensions}-n{self.char_ngram}-{seed_digest}"

    def embed(self, texts: Sequence[str]) -> list[list[float]]:
        return [self._embed_one(text) for text in texts]

    def _embed_one(self, text: str) -> list[float]:
        buckets = [0.0] * self.dimensions
        for feature, weight in self._features(text):
            index, sign = self._bucket(feature)
            buckets[index] += sign * weight

        # L2 normalisation is what lets cosine ranking compare a three-word
        # note against a paragraph: without it, longer text wins on length
        # alone. `fsum` keeps the norm independent of accumulation order.
        norm = math.sqrt(math.fsum(value * value for value in buckets))
        if norm == 0.0:
            # No features at all (empty text, or punctuation only). A zero
            # vector has no direction, which cosine scoring reads as
            # "unrelated to everything" -- the honest answer.
            return buckets
        return [value / norm for value in buckets]

    def _features(self, text: str) -> Iterator[tuple[str, float]]:
        # NFC first, matching every other hashed value in Jarvis: composed and
        # decomposed "café" are the same word and must land in the same bucket.
        normalized = normalize_nfc(text).casefold()
        for word in _WORD.findall(normalized):
            yield f"w:{word}", _WORD_WEIGHT
            # Boundary markers keep a prefix n-gram distinct from the same
            # letters in the middle of a longer word.
            padded = f"^{word}$"
            for start in range(len(padded) - self.char_ngram + 1):
                yield f"c:{padded[start : start + self.char_ngram]}", _CHAR_WEIGHT

    def _bucket(self, feature: str) -> tuple[int, float]:
        # Keyed BLAKE2b: deterministic across processes and platforms, unlike
        # `hash()`, and the key makes the seed genuinely part of the mapping
        # rather than decoration in the model id.
        digest = hashlib.blake2b(
            feature.encode("utf-8"),
            digest_size=8,
            key=self.seed.encode("utf-8"),
        ).digest()
        index = int.from_bytes(digest[:4], "big") % self.dimensions
        sign = -1.0 if digest[4] & 1 else 1.0
        return index, sign


def default_embedding_provider() -> EmbeddingProvider:
    """The provider used when no verified model artifact is available.

    Returns the hash embedder today. When the pinned ONNX MiniLM embedder
    lands, this is the one place that decides between them, so callers never
    grow their own fallback logic.
    """
    return DeterministicHashEmbedder()

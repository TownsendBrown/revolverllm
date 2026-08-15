# LiveCodeBench harness — codegen + sandboxed evaluation against an OpenAI-compatible API.
# https://github.com/LiveCodeBench/LiveCodeBench
# API-only image: skips torch/vllm (not needed when talking to Revolver).
FROM python:3.11-slim-bookworm

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/LiveCodeBench

# Pinned: run_lcb.py patches upstream source, so an unpinned HEAD would silently
# change what is measured (or fail the patch asserts).
ARG LCB_REF=28fef95ea8c9f7a547c8329f2cd3d32b92c1fa24
RUN git init /opt/LiveCodeBench \
  && cd /opt/LiveCodeBench \
  && git remote add origin https://github.com/LiveCodeBench/LiveCodeBench.git \
  && git fetch --depth 1 origin "${LCB_REF}" \
  && git checkout FETCH_HEAD

# Runtime deps for OpenAI codegen + evaluation only (no GPU / vLLM stack).
# anthropic is imported at module load by several prompt formatters even when
# we only run OpenAIChat codegeneration.
# datasets must stay on 3.x: LiveCodeBench's HF datasets still ship loading
# scripts, which datasets>=4 removed ("Dataset scripts are no longer supported").
RUN pip install --no-cache-dir -U pip \
  && pip install --no-cache-dir \
    "annotated-types>=0.7.0" \
    "anthropic>=0.42.0" \
    "datasets>=3.2.0,<4" \
    "huggingface_hub>=0.25.0,<1" \
    "openai>=1.59.6" \
    "pebble>=5.1.0" \
    "numpy" \
    "pyyaml" \
    "tqdm" \
  && pip install --no-cache-dir --no-deps -e .

COPY register_model.py /opt/revolver/register_model.py
COPY run_lcb.py /opt/revolver/run_lcb.py
COPY entrypoint.sh /opt/revolver/entrypoint.sh
RUN chmod +x /opt/revolver/entrypoint.sh

WORKDIR /work
ENV PYTHONUNBUFFERED=1
ENV PYTHONPATH=/opt/revolver
ENTRYPOINT ["/opt/revolver/entrypoint.sh"]

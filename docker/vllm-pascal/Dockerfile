# syntax=docker/dockerfile:1
#
# Pascal (P100 / sm_60) vLLM via sasha0552 community build, with transformers
# pinned to avoid the aimv2 config collision (vLLM <=0.9.1 vs transformers >=4.54).
# Ref: https://github.com/vllm-project/vllm/pull/20921
#
# Build:
#   docker build -t revolver/vllm-pascal:0.9.1 docker/vllm-pascal
#
# Smoke test:
#   docker run --rm revolver/vllm-pascal:0.9.1 python3 -c "import vllm; print(vllm.__version__)"

ARG VLLM_BASE_IMAGE=ghcr.io/sasha0552/vllm:v0.9.1
FROM ${VLLM_BASE_IMAGE}

RUN pip install --no-cache-dir "transformers<4.54.0"

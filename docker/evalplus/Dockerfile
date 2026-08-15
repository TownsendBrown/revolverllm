# EvalPlus harness — HumanEval+/MBPP+ against an OpenAI-compatible API.
# https://github.com/evalplus/evalplus
FROM python:3.11-slim-bookworm

RUN apt-get update \
  && apt-get install -y --no-install-recommends git g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Pinned: run_evalplus.py depends on the 0.3.x results schema and provider layout.
RUN pip install --no-cache-dir -U pip \
  && pip install --no-cache-dir "evalplus==0.3.1" "openai>=1.11.1" \
  && python -c "from evalplus.data import get_human_eval_plus, get_mbpp_plus; get_human_eval_plus(); get_mbpp_plus()"

COPY run_evalplus.py /opt/revolver/run_evalplus.py
COPY entrypoint.sh /opt/revolver/entrypoint.sh
RUN chmod +x /opt/revolver/entrypoint.sh

WORKDIR /app
ENV PYTHONUNBUFFERED=1
ENTRYPOINT ["/opt/revolver/entrypoint.sh"]

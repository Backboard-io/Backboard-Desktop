{ pkgs, lib, config, inputs, ... }:

{
  languages.rust = {
    enable = true;
    targets = ["wasm32-wasip1"];
    channel = "nightly";
  };
}

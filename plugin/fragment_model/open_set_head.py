"""Small permutation-invariant support and clarification head for scoped memory units."""
import torch
from torch import nn
from open_set_features import BGE,WIDTH


FORMAT="compressed-association-support-v1"
REASONS=("supported","unknown_object","unsupported_action","ambiguous_object")


class SupportHead(nn.Module):
    def __init__(self):
        super().__init__()
        self.register_buffer("center",torch.zeros(WIDTH))
        self.register_buffer("scale",torch.ones(WIDTH))
        self.item=nn.Sequential(nn.Linear(WIDTH,48),nn.LayerNorm(48),nn.GELU(),nn.Linear(48,32),nn.Tanh())
        self.roles=nn.Linear(32,3)
        self.reason=nn.Sequential(nn.Linear(32*3+7,48),nn.GELU(),nn.Linear(48,4))

    def forward(self,x,mask):
        h=self.item(((x-self.center)/self.scale).clamp(-6.,6.))
        parts=self.roles(h)
        n=mask.sum(1,keepdim=True).clamp_min(1)
        wide=mask[...,None]
        maximum=h.masked_fill(~wide,-1e4).amax(1)
        mean=(h*wide).sum(1)/n
        i=x[:,:,BGE].masked_fill(~mask,-1e4).argmax(1)
        leader=h[torch.arange(len(h),device=h.device),i]
        valid_parts=parts.masked_fill(~wide,-1e4)
        first=valid_parts.amax(1)
        other=(parts*wide).sum(1)/n
        scores=self.reason(torch.cat((maximum,mean,leader,first,other,torch.log2(n.float())/4),1))
        return scores,parts


def load_head(path,parent,device):
    blob=torch.load(path,map_location="cpu",weights_only=True)
    if blob["format"]!=FORMAT or blob["parent_sha256"]!=parent:
        raise ValueError("Association head and reader do not match")
    net=SupportHead()
    net.load_state_dict(blob["state_dict"],strict=True)
    return net.to(device).eval(),blob["gate"]

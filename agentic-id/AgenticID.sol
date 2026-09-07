// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// ConSSS Wars 的 Agentic ID（ERC-7857 精簡版，依 docs.0g.ai 整合指南的介面）：
/// mint(recipient, encryptedURI, metadataHash) / ownerOf / getMetadataHash / getEncryptedURI
/// 一枚 token = 一個 AI 指揮官身份；metadataHash 是指揮官 system prompt 與模型設定的 sha256。
contract AgenticID {
    string public constant name = "ConSSS Wars Agentic ID";
    string public constant symbol = "CWAID";

    uint256 private _nextId = 1;
    mapping(uint256 => address) private _owners;
    mapping(uint256 => string) private _encryptedURIs;
    mapping(uint256 => bytes32) private _metadataHashes;

    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Minted(uint256 indexed tokenId, address indexed to, bytes32 metadataHash, string encryptedURI);

    function mint(address recipient, string calldata encryptedURI, bytes32 metadataHash) external returns (uint256 tokenId) {
        require(recipient != address(0), "zero recipient");
        tokenId = _nextId++;
        _owners[tokenId] = recipient;
        _encryptedURIs[tokenId] = encryptedURI;
        _metadataHashes[tokenId] = metadataHash;
        emit Transfer(address(0), recipient, tokenId);
        emit Minted(tokenId, recipient, metadataHash, encryptedURI);
    }

    function ownerOf(uint256 tokenId) external view returns (address) {
        address o = _owners[tokenId];
        require(o != address(0), "no token");
        return o;
    }

    function getMetadataHash(uint256 tokenId) external view returns (bytes32) { return _metadataHashes[tokenId]; }
    function getEncryptedURI(uint256 tokenId) external view returns (string memory) { return _encryptedURIs[tokenId]; }
    function totalMinted() external view returns (uint256) { return _nextId - 1; }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC1155Minimal {
    function safeTransferFrom(address from, address to, uint256 id, uint256 amount, bytes calldata data) external;
}

contract RialoNftMarketplace {
    struct Listing { address seller; uint256 tokenId; uint256 amount; uint256 pricePerUnit; bool active; }
    IERC1155Minimal public immutable nft;
    mapping(bytes32 => Listing) public listings;
    uint256 private unlocked = 1;

    event NFTListed(address indexed seller, uint256 indexed tokenId, uint256 amount, uint256 pricePerUnit);
    event NFTListingCancelled(address indexed seller, uint256 indexed tokenId, uint256 amount);
    event NFTPurchased(address indexed buyer, address indexed seller, uint256 indexed tokenId, uint256 amount, uint256 totalPrice);

    modifier nonReentrant() { require(unlocked == 1, "reentrancy"); unlocked = 2; _; unlocked = 1; }

    constructor(address nftAddress) { require(nftAddress != address(0), "zero NFT"); nft = IERC1155Minimal(nftAddress); }

    function getListingKey(address seller, uint256 tokenId) public pure returns (bytes32) {
        return keccak256(abi.encode(seller, tokenId));
    }

    function list(uint256 tokenId, uint256 amount, uint256 pricePerUnit) external nonReentrant {
        require(amount > 0 && pricePerUnit > 0, "invalid listing");
        bytes32 key = getListingKey(msg.sender, tokenId);
        Listing storage current = listings[key];
        require(!current.active, "already listed");
        nft.safeTransferFrom(msg.sender, address(this), tokenId, amount, "");
        listings[key] = Listing(msg.sender, tokenId, amount, pricePerUnit, true);
        emit NFTListed(msg.sender, tokenId, amount, pricePerUnit);
    }

    function cancel(uint256 tokenId, uint256 amount) external nonReentrant {
        bytes32 key = getListingKey(msg.sender, tokenId);
        Listing storage current = listings[key];
        require(current.active && amount > 0 && amount <= current.amount, "invalid cancellation");
        current.amount -= amount;
        if (current.amount == 0) current.active = false;
        nft.safeTransferFrom(address(this), msg.sender, tokenId, amount, "");
        emit NFTListingCancelled(msg.sender, tokenId, amount);
    }

    function buy(address seller, uint256 tokenId, uint256 amount) external payable nonReentrant {
        bytes32 key = getListingKey(seller, tokenId);
        Listing storage current = listings[key];
        require(current.active && amount > 0 && amount <= current.amount, "invalid purchase");
        uint256 totalPrice = current.pricePerUnit * amount;
        require(msg.value >= totalPrice, "insufficient payment");
        current.amount -= amount;
        if (current.amount == 0) current.active = false;
        nft.safeTransferFrom(address(this), msg.sender, tokenId, amount, "");
        (bool paid,) = payable(seller).call{value: totalPrice}("");
        require(paid, "seller payment failed");
        if (msg.value > totalPrice) {
            (bool refunded,) = payable(msg.sender).call{value: msg.value - totalPrice}("");
            require(refunded, "refund failed");
        }
        emit NFTPurchased(msg.sender, seller, tokenId, amount, totalPrice);
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == 0x01ffc9a7 || interfaceId == 0x4e2312e0;
    }
    function onERC1155Received(address,address,uint256,uint256,bytes calldata) external pure returns (bytes4) { return 0xf23a6e61; }
    function onERC1155BatchReceived(address,address,uint256[] calldata,uint256[] calldata,bytes calldata) external pure returns (bytes4) { return 0xbc197c81; }
}

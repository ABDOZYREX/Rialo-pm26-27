// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Rialo Player NFT
/// @notice ERC-1155 player cards used by Rialo PM on Ethereum Sepolia.
/// @dev Self-contained so it can be compiled and deployed directly in Remix.
contract RialoPlayerNFT {
    string public name = "Rialo Player NFT";
    string public symbol = "RPNFT";

    address public owner;
    string private baseMetadataUri;
    uint256 public defaultMintPrice;

    mapping(uint256 => uint256) private tokenMintPrices;
    mapping(uint256 => mapping(address => uint256)) private balances;
    mapping(address => mapping(address => bool)) private operatorApprovals;

    event TransferSingle(
        address indexed operator,
        address indexed from,
        address indexed to,
        uint256 id,
        uint256 value
    );
    event ApprovalForAll(address indexed account, address indexed operator, bool approved);
    event URI(string value, uint256 indexed id);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event MintPriceUpdated(uint256 indexed tokenId, uint256 price);

    error NotOwner();
    error InvalidAddress();
    error InvalidAmount();
    error InsufficientPayment(uint256 required, uint256 supplied);
    error InsufficientBalance();
    error NotApproved();
    error TransferFailed();
    error UnsafeRecipient();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(string memory initialBaseUri, uint256 initialDefaultMintPrice) {
        owner = msg.sender;
        baseMetadataUri = initialBaseUri;
        defaultMintPrice = initialDefaultMintPrice;
        emit OwnershipTransferred(address(0), msg.sender);
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return
            interfaceId == 0x01ffc9a7 || // ERC-165
            interfaceId == 0xd9b67a26 || // ERC-1155
            interfaceId == 0x0e89341c;   // ERC-1155 metadata URI
    }

    function uri(uint256 tokenId) external view returns (string memory) {
        return string.concat(baseMetadataUri, _toString(tokenId), ".json");
    }

    function balanceOf(address account, uint256 id) public view returns (uint256) {
        if (account == address(0)) revert InvalidAddress();
        return balances[id][account];
    }

    function balanceOfBatch(
        address[] calldata accounts,
        uint256[] calldata ids
    ) external view returns (uint256[] memory result) {
        if (accounts.length != ids.length) revert InvalidAmount();
        result = new uint256[](accounts.length);
        for (uint256 i; i < accounts.length; ++i) {
            result[i] = balanceOf(accounts[i], ids[i]);
        }
    }

    function isApprovedForAll(address account, address operator) external view returns (bool) {
        return operatorApprovals[account][operator];
    }

    function setApprovalForAll(address operator, bool approved) external {
        if (operator == msg.sender) revert InvalidAddress();
        operatorApprovals[msg.sender][operator] = approved;
        emit ApprovalForAll(msg.sender, operator, approved);
    }

    function mintPrice(uint256 tokenId) public view returns (uint256) {
        uint256 customPrice = tokenMintPrices[tokenId];
        return customPrice == 0 ? defaultMintPrice : customPrice;
    }

    function mint(uint256 tokenId, uint256 amount) external payable {
        if (amount == 0) revert InvalidAmount();
        uint256 requiredPayment = mintPrice(tokenId) * amount;
        if (msg.value < requiredPayment) {
            revert InsufficientPayment(requiredPayment, msg.value);
        }

        balances[tokenId][msg.sender] += amount;
        emit TransferSingle(msg.sender, address(0), msg.sender, tokenId, amount);

        uint256 refund = msg.value - requiredPayment;
        if (refund != 0) {
            (bool refunded, ) = payable(msg.sender).call{value: refund}("");
            if (!refunded) revert TransferFailed();
        }
    }

    function safeTransferFrom(
        address from,
        address to,
        uint256 id,
        uint256 amount,
        bytes calldata data
    ) external {
        if (msg.sender != from && !operatorApprovals[from][msg.sender]) revert NotApproved();
        _safeTransferFrom(from, to, id, amount, data);
    }

    function setDefaultMintPrice(uint256 newPrice) external onlyOwner {
        defaultMintPrice = newPrice;
        emit MintPriceUpdated(0, newPrice);
    }

    function setMintPrice(uint256 tokenId, uint256 newPrice) external onlyOwner {
        tokenMintPrices[tokenId] = newPrice;
        emit MintPriceUpdated(tokenId, newPrice);
    }

    function setBaseUri(string calldata newBaseUri) external onlyOwner {
        baseMetadataUri = newBaseUri;
        emit URI(newBaseUri, 0);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert InvalidAddress();
        address previousOwner = owner;
        owner = newOwner;
        emit OwnershipTransferred(previousOwner, newOwner);
    }

    function withdraw(address payable recipient) external onlyOwner {
        if (recipient == address(0)) revert InvalidAddress();
        (bool sent, ) = recipient.call{value: address(this).balance}("");
        if (!sent) revert TransferFailed();
    }

    function _safeTransferFrom(
        address from,
        address to,
        uint256 id,
        uint256 amount,
        bytes calldata data
    ) private {
        if (to == address(0)) revert InvalidAddress();
        uint256 fromBalance = balances[id][from];
        if (fromBalance < amount) revert InsufficientBalance();

        unchecked {
            balances[id][from] = fromBalance - amount;
        }
        balances[id][to] += amount;
        emit TransferSingle(msg.sender, from, to, id, amount);

        if (to.code.length != 0) {
            (bool success, bytes memory response) = to.call(
                abi.encodeWithSelector(
                    bytes4(keccak256("onERC1155Received(address,address,uint256,uint256,bytes)")),
                    msg.sender,
                    from,
                    id,
                    amount,
                    data
                )
            );
            if (!success || response.length < 32 || abi.decode(response, (bytes4)) != 0xf23a6e61) {
                revert UnsafeRecipient();
            }
        }
    }

    function _toString(uint256 value) private pure returns (string memory) {
        if (value == 0) return "0";
        uint256 digits;
        uint256 temp = value;
        while (temp != 0) {
            ++digits;
            temp /= 10;
        }
        bytes memory buffer = new bytes(digits);
        while (value != 0) {
            digits -= 1;
            buffer[digits] = bytes1(uint8(48 + value % 10));
            value /= 10;
        }
        return string(buffer);
    }
}
